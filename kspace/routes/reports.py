from __future__ import annotations

import base64
import io
import json
import math
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pypdf import PageObject, PdfReader, PdfWriter, Transformation
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

router = APIRouter(prefix="/reports", tags=["Reports"])

REPORT_METADATA_PREFIX = "KSPACE_REPORT_V1:"
MAX_IMAGE_BYTES = 7 * 1024 * 1024
MAX_PDF_BYTES = 25 * 1024 * 1024


class ReportExportRequest(BaseModel):
    title: str = "K-SPACE Reconstruction Report"
    source: Dict[str, str] = Field(default_factory=dict)
    settings: Dict[str, str] = Field(default_factory=dict)
    metrics: Dict[str, str] = Field(default_factory=dict)
    noise_metrics: Dict[str, str] = Field(default_factory=dict)
    target_metrics: Dict[str, str] = Field(default_factory=dict)
    frequency: Dict[str, str] = Field(default_factory=dict)
    images: Dict[str, str] = Field(default_factory=dict)
    log: List[str] = Field(default_factory=list)


def _safe_text(value: object, fallback: str = "-") -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return fallback
    # ReportLab's built-in Helvetica is intentionally used so the generated
    # PDFs stay dependency-free on Windows. Normalize characters outside its
    # practical WinAnsi coverage instead of allowing missing-glyph boxes.
    text = (text.replace("∞", "Infinity")
                .replace("−", "-")
                .replace("–", "-")
                .replace("—", "-")
                .replace("→", "->"))
    return text.encode("cp1252", errors="replace").decode("cp1252")


def _decode_data_url(data_url: str) -> bytes:
    if not data_url or not data_url.startswith("data:image/") or "," not in data_url:
        raise ValueError("not an image data URL")
    header, encoded = data_url.split(",", 1)
    if ";base64" not in header:
        raise ValueError("image data URL must be base64 encoded")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image is too large")
    return raw


def _image_flowable(data_url: Optional[str], width_mm: float = 53.0, height_mm: float = 53.0):
    if not data_url:
        return None
    try:
        raw = _decode_data_url(data_url)
        image = Image(io.BytesIO(raw))
        iw = float(image.imageWidth or 1)
        ih = float(image.imageHeight or 1)
        max_w = width_mm * mm
        max_h = height_mm * mm
        scale = min(max_w / iw, max_h / ih)
        image.drawWidth = max(1.0, iw * scale)
        image.drawHeight = max(1.0, ih * scale)
        return image
    except Exception:
        return None


def _metric_rows(metrics: Dict[str, str]) -> List[List[str]]:
    labels = [
        ("sampling_density", "Sampling density"),
        ("points", "k-space points kept"),
        ("mse", "MSE"),
        ("psnr", "PSNR"),
        ("nrmse", "NRMSE"),
    ]
    return [[label, _safe_text(metrics.get(key))] for key, label in labels]


def _section_table(rows: List[List[str]], widths=(62, 108)) -> Table:
    table = Table(rows, colWidths=[w * mm for w in widths], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#526074")),
        ("TEXTCOLOR", (1, 0), (1, -1), colors.HexColor("#182235")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F7F9FC")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#DDE3EC")),
        ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#E7EBF1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def _image_card(label: str, data_url: Optional[str], caption: str, styles):
    image = _image_flowable(data_url)
    if image is None:
        body = Paragraph("Not available in the current run.", styles["SmallMuted"])
    else:
        body = image
    return [
        Paragraph(label, styles["CardTitle"]),
        Spacer(1, 2 * mm),
        body,
        Spacer(1, 1.5 * mm),
        Paragraph(caption, styles["SmallMuted"]),
    ]


def _metadata_payload(payload: ReportExportRequest) -> Dict[str, object]:
    return {
        "version": 1,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source": payload.source,
        "settings": payload.settings,
        "metrics": payload.metrics,
        "noise_metrics": payload.noise_metrics,
        "target_metrics": payload.target_metrics,
        "frequency": payload.frequency,
    }


def _build_report(payload: ReportExportRequest) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=18 * mm,
        bottomMargin=17 * mm,
        title=payload.title,
        author="K-SPACE Reconstruction Workbench",
    )

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="ReportTitle", parent=styles["Title"], fontName="Helvetica-Bold",
        fontSize=20, leading=24, textColor=colors.HexColor("#182235"), alignment=TA_LEFT,
        spaceAfter=4 * mm,
    ))
    styles.add(ParagraphStyle(
        name="Section", parent=styles["Heading2"], fontName="Helvetica-Bold",
        fontSize=12.5, leading=15, textColor=colors.HexColor("#22304A"),
        spaceBefore=2 * mm, spaceAfter=3 * mm,
    ))
    styles.add(ParagraphStyle(
        name="CardTitle", parent=styles["Heading4"], fontName="Helvetica-Bold",
        fontSize=9.2, leading=11, textColor=colors.HexColor("#31405D"), alignment=TA_CENTER,
        spaceAfter=0,
    ))
    styles.add(ParagraphStyle(
        name="SmallMuted", parent=styles["BodyText"], fontName="Helvetica",
        fontSize=7.3, leading=9, textColor=colors.HexColor("#6C788B"), alignment=TA_CENTER,
    ))
    styles.add(ParagraphStyle(
        name="BodySmall", parent=styles["BodyText"], fontName="Helvetica",
        fontSize=8.2, leading=11, textColor=colors.HexColor("#4B5870"),
    ))

    story = []
    created = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    story.append(Paragraph(payload.title, styles["ReportTitle"]))
    story.append(Paragraph(
        f"Generated by K-SPACE on {created}. This report captures the active reconstruction state, sampling configuration, quantitative metrics and available analysis views.",
        styles["BodySmall"],
    ))
    story.append(Spacer(1, 4 * mm))

    source_rows = [["Source type", _safe_text(payload.source.get("type"))]]
    if payload.source.get("name"):
        source_rows.append(["Source", _safe_text(payload.source.get("name"))])
    if payload.source.get("slice"):
        source_rows.append(["Slice", _safe_text(payload.source.get("slice"))])
    source_rows.extend([
        ["Sampling method", _safe_text(payload.settings.get("pattern"))],
        ["Acceleration", _safe_text(payload.settings.get("acceleration"))],
        ["ACS", _safe_text(payload.settings.get("acs"))],
        ["Noise level", _safe_text(payload.settings.get("noise_level"))],
    ])

    story.append(Paragraph("Run overview", styles["Section"]))
    overview = Table([
        [_section_table(source_rows, widths=(40, 45)), _section_table(_metric_rows(payload.metrics), widths=(40, 45))]
    ], colWidths=[87.5 * mm, 87.5 * mm])
    overview.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(overview)
    story.append(Spacer(1, 5 * mm))

    story.append(Paragraph("Reconstruction summary", styles["Section"]))
    image_cells = [
        _image_card("A  Source image", payload.images.get("source"), "Fully sampled reference / loaded source.", styles),
        _image_card("E  Reconstruction", payload.images.get("reconstruction"), "Image reconstructed from the sampled k-space.", styles),
        _image_card("F  Error map", payload.images.get("error"), "Absolute reconstruction error visualization.", styles),
    ]
    image_table = Table([image_cells], colWidths=[58.5 * mm, 58.5 * mm, 58.5 * mm])
    image_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#DFE5EE")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E8ECF2")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FBFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(image_table)

    story.append(PageBreak())
    story.append(Paragraph("Sampling and k-space", styles["Section"]))
    sampling_cards = [
        _image_card("B  Full k-space", payload.images.get("kspace_full"), "Log-magnitude view of the complete k-space.", styles),
        _image_card("D  Sampling mask", payload.images.get("mask"), "White pixels represent retained k-space samples.", styles),
        _image_card("C  Undersampled k-space", payload.images.get("kspace_under"), "Measured / retained k-space after applying the mask and current noise setting.", styles),
    ]
    sample_table = Table([sampling_cards], colWidths=[58.5 * mm, 58.5 * mm, 58.5 * mm])
    sample_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#DFE5EE")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E8ECF2")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FBFCFE")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(sample_table)
    story.append(Spacer(1, 5 * mm))

    story.append(Paragraph("Noise review", styles["Section"]))
    noise_rows = [
        ["Noise level / approximate SNR", _safe_text(payload.noise_metrics.get("noise"))],
        ["PSNR - no noise", _safe_text(payload.noise_metrics.get("psnr_clean"))],
        ["MSE - no noise", _safe_text(payload.noise_metrics.get("mse_clean"))],
        ["NRMSE - no noise", _safe_text(payload.noise_metrics.get("nrmse_clean"))],
        ["PSNR lost to noise", _safe_text(payload.noise_metrics.get("psnr_drop"))],
    ]
    story.append(_section_table(noise_rows, widths=(68, 102)))

    target_has_data = any(_safe_text(v, "") for v in payload.target_metrics.values())
    frequency_has_data = bool(payload.images.get("frequency_low") or payload.images.get("frequency_high") or payload.images.get("frequency_comparison"))
    if target_has_data or frequency_has_data or payload.log:
        story.append(PageBreak())
        story.append(Paragraph("Additional analysis", styles["Section"]))

        if target_has_data:
            story.append(Paragraph("Target-error search", styles["BodySmall"]))
            target_rows = [
                ["Metric", _safe_text(payload.target_metrics.get("metric"))],
                ["Requested target", _safe_text(payload.target_metrics.get("target"))],
                ["Achieved", _safe_text(payload.target_metrics.get("achieved"))],
                ["Density", _safe_text(payload.target_metrics.get("density"))],
                ["Status", _safe_text(payload.target_metrics.get("status"))],
            ]
            story.append(Spacer(1, 2 * mm))
            story.append(_section_table(target_rows, widths=(55, 115)))
            story.append(Spacer(1, 5 * mm))

        if frequency_has_data:
            story.append(Paragraph("MRI frequency-region comparison", styles["BodySmall"]))
            story.append(Spacer(1, 2 * mm))
            freq_cards = [
                _image_card("Low-frequency reconstruction", payload.images.get("frequency_low"), "Outer k-space removed; central frequencies retained.", styles),
                _image_card("High-frequency reconstruction", payload.images.get("frequency_high"), "Central k-space removed; outer frequencies retained.", styles),
                _image_card("Current comparison", payload.images.get("frequency_comparison"), "Current comparison canvas from the MRI frequency workspace.", styles),
            ]
            freq_table = Table([freq_cards], colWidths=[58.5 * mm, 58.5 * mm, 58.5 * mm])
            freq_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#DFE5EE")),
                ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E8ECF2")),
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FBFCFE")),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]))
            story.append(freq_table)
            freq_rows = [["Comparison mode", _safe_text(payload.frequency.get("mode"))], ["Center radius", _safe_text(payload.frequency.get("cutoff"))]]
            story.append(Spacer(1, 3 * mm))
            story.append(_section_table(freq_rows, widths=(55, 115)))
            story.append(Spacer(1, 5 * mm))

        if payload.log:
            story.append(Paragraph("Run log", styles["BodySmall"]))
            log_text = "<br/>".join(f"{i + 1}. {_safe_text(entry)}" for i, entry in enumerate(payload.log[-18:]))
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(log_text, styles["BodySmall"]))

    meta = _metadata_payload(payload)
    subject = REPORT_METADATA_PREFIX + json.dumps(meta, separators=(",", ":"), ensure_ascii=True)

    def _on_page(canvas, doc_obj):
        canvas.saveState()
        canvas.setTitle(payload.title)
        canvas.setAuthor("K-SPACE Reconstruction Workbench")
        canvas.setSubject(subject)
        page_no = canvas.getPageNumber()
        width, height = A4
        canvas.setStrokeColor(colors.HexColor("#E1E6EE"))
        canvas.setLineWidth(0.5)
        canvas.line(16 * mm, 12 * mm, width - 16 * mm, 12 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#79859A"))
        canvas.drawString(16 * mm, 8.5 * mm, "K-SPACE Reconstruction Workbench")
        canvas.drawRightString(width - 16 * mm, 8.5 * mm, f"Page {page_no}")
        canvas.restoreState()

    doc.build(story, onFirstPage=_on_page, onLaterPages=_on_page)
    return buffer.getvalue()


def _read_report_metadata(reader: PdfReader) -> Dict[str, object]:
    metadata = reader.metadata or {}
    subject = str(metadata.get("/Subject") or metadata.get("subject") or "")
    if subject.startswith(REPORT_METADATA_PREFIX):
        try:
            parsed = json.loads(subject[len(REPORT_METADATA_PREFIX):])
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass

    text = "\n".join((page.extract_text() or "") for page in reader.pages[:4])
    metric_patterns = {
        "sampling_density": r"Sampling density\s+([^\n]+)",
        "points": r"k-space points kept\s+([^\n]+)",
        "mse": r"MSE\s+([^\n]+)",
        "psnr": r"PSNR\s+([^\n]+)",
        "nrmse": r"NRMSE\s+([^\n]+)",
    }
    metrics = {}
    for key, pattern in metric_patterns.items():
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            metrics[key] = match.group(1).strip()
    return {"version": 0, "metrics": metrics, "source": {}, "settings": {}, "noise_metrics": {}}


def _numeric(value: object) -> Optional[float]:
    text = _safe_text(value, "")
    if not text or text in {"-", "—"}:
        return None
    lowered = text.lower().replace("∞", "inf")
    if lowered.startswith("inf") or "infinity" in lowered:
        return math.inf
    match = re.search(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", text.replace(",", ""))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _delta_text(a: object, b: object) -> str:
    av = _numeric(a)
    bv = _numeric(b)
    if av is None or bv is None:
        return "-"
    if math.isinf(av) and math.isinf(bv):
        return "0"
    if math.isinf(av) or math.isinf(bv):
        return "not finite"
    delta = av - bv
    if abs(delta) >= 1000 or (0 < abs(delta) < 0.001):
        return f"{delta:+.3e}"
    return f"{delta:+.4f}".rstrip("0").rstrip(".")


def _comparison_summary(meta_a: Dict[str, object], meta_b: Dict[str, object], name_a: str, name_b: str) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4, rightMargin=16 * mm, leftMargin=16 * mm,
        topMargin=18 * mm, bottomMargin=17 * mm,
        title="K-SPACE Report Comparison", author="K-SPACE Reconstruction Workbench",
    )
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="CmpTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=19, leading=23, textColor=colors.HexColor("#182235"), spaceAfter=3 * mm))
    styles.add(ParagraphStyle(name="CmpBody", parent=styles["BodyText"], fontSize=8.5, leading=11, textColor=colors.HexColor("#526074")))
    styles.add(ParagraphStyle(name="CmpSection", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=12.5, textColor=colors.HexColor("#22304A"), spaceBefore=4 * mm, spaceAfter=3 * mm))

    story = [
        Paragraph("K-SPACE Report Comparison", styles["CmpTitle"]),
        Paragraph("This comparison summarizes the structured metrics and acquisition settings found in the two selected K-SPACE reports. Side-by-side visual page comparisons follow this summary, and both complete original reports are appended for traceability.", styles["CmpBody"]),
        Spacer(1, 4 * mm),
    ]

    source_a = meta_a.get("source", {}) if isinstance(meta_a.get("source"), dict) else {}
    source_b = meta_b.get("source", {}) if isinstance(meta_b.get("source"), dict) else {}
    identity = Table([
        ["", "Report A", "Report B"],
        ["File", _safe_text(name_a), _safe_text(name_b)],
        ["Source", _safe_text(source_a.get("name") or source_a.get("type")), _safe_text(source_b.get("name") or source_b.get("type"))],
        ["Slice", _safe_text(source_a.get("slice")), _safe_text(source_b.get("slice"))],
    ], colWidths=[34 * mm, 71 * mm, 71 * mm])
    identity.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF2F8")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.2),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#26344C")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#D9E0EA")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#E4E9F0")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(identity)

    metrics_a = meta_a.get("metrics", {}) if isinstance(meta_a.get("metrics"), dict) else {}
    metrics_b = meta_b.get("metrics", {}) if isinstance(meta_b.get("metrics"), dict) else {}
    metric_specs = [
        ("sampling_density", "Sampling density"),
        ("points", "k-space points kept"),
        ("mse", "MSE"),
        ("psnr", "PSNR"),
        ("nrmse", "NRMSE"),
    ]
    rows = [["Metric", "Report A", "Report B", "A - B"]]
    for key, label in metric_specs:
        a = _safe_text(metrics_a.get(key))
        b = _safe_text(metrics_b.get(key))
        rows.append([label, a, b, _delta_text(a, b)])

    story.append(Paragraph("Reconstruction metrics", styles["CmpSection"]))
    metrics_table = Table(rows, colWidths=[52 * mm, 42 * mm, 42 * mm, 40 * mm])
    metrics_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF0FF")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.3),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#26344C")),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#D6DFEE")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#E4E9F1")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFBFD")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(metrics_table)

    settings_a = meta_a.get("settings", {}) if isinstance(meta_a.get("settings"), dict) else {}
    settings_b = meta_b.get("settings", {}) if isinstance(meta_b.get("settings"), dict) else {}
    setting_specs = [
        ("pattern", "Sampling method"),
        ("acceleration", "Acceleration"),
        ("acs", "ACS"),
        ("noise_level", "Noise level"),
    ]
    setting_rows = [["Setting", "Report A", "Report B"]]
    for key, label in setting_specs:
        setting_rows.append([label, _safe_text(settings_a.get(key)), _safe_text(settings_b.get(key))])

    story.append(Paragraph("Run settings", styles["CmpSection"]))
    settings_table = Table(setting_rows, colWidths=[58.5 * mm, 58.5 * mm, 58.5 * mm])
    settings_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F0F3F7")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.3),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#26344C")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#D9E0EA")),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#E4E9F0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(settings_table)

    story.append(Spacer(1, 5 * mm))
    story.append(Paragraph("Appendices", styles["CmpSection"]))
    story.append(Paragraph("The next pages place corresponding pages from Report A and Report B side by side for visual review. Appendix A then contains the complete first report and Appendix B contains the complete second report. The metric delta column above is calculated as Report A minus Report B.", styles["CmpBody"]))

    def _footer(canvas, doc_obj):
        canvas.saveState()
        width, _ = A4
        canvas.setStrokeColor(colors.HexColor("#E1E6EE"))
        canvas.line(16 * mm, 12 * mm, width - 16 * mm, 12 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#79859A"))
        canvas.drawString(16 * mm, 8.5 * mm, "K-SPACE Report Comparison")
        canvas.drawRightString(width - 16 * mm, 8.5 * mm, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buffer.getvalue()


def _visual_comparison_pages(reader_a: PdfReader, reader_b: PdfReader, name_a: str, name_b: str):
    """Create landscape pages with corresponding report pages side by side."""
    out = []
    page_width, page_height = landscape(A4)
    left_margin = 10 * mm
    right_margin = 10 * mm
    gutter = 7 * mm
    header_height = 23 * mm
    bottom_margin = 9 * mm
    pane_width = (page_width - left_margin - right_margin - gutter) / 2
    pane_height = page_height - header_height - bottom_margin
    total = min(max(len(reader_a.pages), len(reader_b.pages)), 6)

    for index in range(total):
        bg_buf = io.BytesIO()
        c = pdf_canvas.Canvas(bg_buf, pagesize=(page_width, page_height))
        c.setFillColor(colors.HexColor("#F7F9FC"))
        c.rect(0, 0, page_width, page_height, fill=1, stroke=0)
        c.setFillColor(colors.HexColor("#1C2840"))
        c.setFont("Helvetica-Bold", 13)
        c.drawString(left_margin, page_height - 10 * mm, f"Visual comparison - page {index + 1}")
        c.setFont("Helvetica-Bold", 8.5)
        c.setFillColor(colors.HexColor("#40506A"))
        c.drawString(left_margin, page_height - 17 * mm, f"REPORT A  |  {name_a}")
        c.drawString(left_margin + pane_width + gutter, page_height - 17 * mm, f"REPORT B  |  {name_b}")
        c.setStrokeColor(colors.HexColor("#D9E0EA"))
        c.line(left_margin, page_height - 20 * mm, page_width - right_margin, page_height - 20 * mm)
        c.save()
        bg_buf.seek(0)
        page = PdfReader(bg_buf).pages[0]

        def merge(source_page, x0):
            if source_page is None:
                return
            sw = float(source_page.mediabox.width)
            sh = float(source_page.mediabox.height)
            if sw <= 0 or sh <= 0:
                return
            scale = min(pane_width / sw, pane_height / sh)
            draw_w = sw * scale
            draw_h = sh * scale
            tx = x0 + (pane_width - draw_w) / 2
            ty = bottom_margin + (pane_height - draw_h) / 2
            page.merge_transformed_page(source_page, Transformation().scale(scale).translate(tx, ty))

        merge(reader_a.pages[index] if index < len(reader_a.pages) else None, left_margin)
        merge(reader_b.pages[index] if index < len(reader_b.pages) else None, left_margin + pane_width + gutter)
        out.append(page)
    return out


def _divider_pdf(title: str, subtitle: str) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=20 * mm, leftMargin=20 * mm, topMargin=55 * mm, bottomMargin=20 * mm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(name="DividerTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=24, leading=29, textColor=colors.HexColor("#1C2840"), alignment=TA_LEFT)
    body_style = ParagraphStyle(name="DividerBody", parent=styles["BodyText"], fontSize=10, leading=14, textColor=colors.HexColor("#627087"))
    doc.build([Paragraph(title, title_style), Spacer(1, 7 * mm), Paragraph(subtitle, body_style)])
    return buffer.getvalue()


@router.post("/export")
async def export_report(payload: ReportExportRequest):
    if not payload.images.get("source"):
        raise HTTPException(status_code=400, detail="A source image is required before exporting a report.")
    if not payload.images.get("reconstruction"):
        raise HTTPException(status_code=400, detail="Run a reconstruction before exporting the report.")
    try:
        pdf = _build_report(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not generate PDF report: {exc}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="kspace_report_{timestamp}.pdf"'},
    )


@router.post("/compare")
async def compare_reports(
    report_a: UploadFile = File(...),
    report_b: UploadFile = File(...),
):
    files = []
    for upload in (report_a, report_b):
        raw = await upload.read()
        if len(raw) > MAX_PDF_BYTES:
            raise HTTPException(status_code=413, detail=f"{upload.filename or 'PDF'} exceeds the 25 MB limit.")
        if not raw.startswith(b"%PDF"):
            raise HTTPException(status_code=400, detail=f"{upload.filename or 'File'} is not a valid PDF.")
        try:
            reader = PdfReader(io.BytesIO(raw))
            if not reader.pages:
                raise ValueError("PDF has no pages")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read {upload.filename or 'PDF'}: {exc}")
        files.append((upload.filename or "report.pdf", raw, reader))

    name_a, raw_a, reader_a = files[0]
    name_b, raw_b, reader_b = files[1]
    meta_a = _read_report_metadata(reader_a)
    meta_b = _read_report_metadata(reader_b)

    summary_pdf = _comparison_summary(meta_a, meta_b, name_a, name_b)
    divider_a = _divider_pdf("Appendix A - Report A", name_a)
    divider_b = _divider_pdf("Appendix B - Report B", name_b)

    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(summary_pdf)).pages:
        writer.add_page(page)
    for page in _visual_comparison_pages(reader_a, reader_b, name_a, name_b):
        writer.add_page(page)
    for page in PdfReader(io.BytesIO(divider_a)).pages:
        writer.add_page(page)
    for page in reader_a.pages:
        writer.add_page(page)
    for page in PdfReader(io.BytesIO(divider_b)).pages:
        writer.add_page(page)
    for page in reader_b.pages:
        writer.add_page(page)

    try:
        writer.add_metadata({
            "/Title": "K-SPACE Report Comparison",
            "/Author": "K-SPACE Reconstruction Workbench",
            "/Subject": "Comparison of two K-SPACE reconstruction reports",
        })
    except Exception:
        pass

    output = io.BytesIO()
    writer.write(output)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return Response(
        output.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="kspace_report_comparison_{timestamp}.pdf"'},
    )
