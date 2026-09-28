# MRIK Space

**An interactive playground for MRI k-space: sample it, undersample it, reconstruct it, measure the damage, and even hear it.**

MRIK Space turns the abstract signal-processing chain behind every MRI scan — image → frequency domain → sampling → reconstruction — into something you can see, adjust, and interact with in real time. Instead of a single "before/after" comparison, it exposes every stage of the pipeline as its own panel, so you can watch exactly where information is lost and how much it costs.

---

## Why

An MRI scanner never measures a picture. It measures the **frequency content** of the image, called **k-space**, and 100% of the image's information lives there before it's ever turned into pixels. Real scanners often skip parts of k-space to scan faster — this project answers the question: *what happens to the image when they do?*

## Features

- **Full pipeline visualization** — dataset → preprocessing → 2D Fourier Transform → k-space → sampling → reconstruction → metrics, each shown as its own panel
- **Two input modes**
  - Upload any photo, treated as a synthetic MRI slice
  - Load a real multi-coil k-space scan (`.h5`)
- **Undersampling masks**: Cartesian, radial, random, variable-density, and custom hand-painted patterns, all with an adjustable acceleration factor (`R`)
- **Auto-mask search** — give it a target metric (e.g. "PSNR = 30 dB") and it binary-searches sampling density to find a mask that hits it, instead of trial-and-error
- **Noise simulation** — separates acquisition noise from undersampling error so you can see each one's contribution independently
- **Quantitative evaluation** — MSE, PSNR, NRMSE, and a per-pixel error heatmap, all updating live as you change parameters
- **Multi-coil support** — combines coil images via root-sum-of-squares (RSS) reconstruction, with slice-by-slice video playback for multi-slice `.h5` datasets
- **Sonification** — turns any panel (image, k-space, error map) into sound, so you can *hear* what undersampling and noise do to the signal, with side-by-side A/B comparison, pitch-time maps, waveform overlays, and `.wav` export

## How it works

```
  MRI image ──2D FFT──▶ k-space ──sampling mask──▶ undersampled k-space
                                                            │
                                                       inverse FFT
                                                            │
                                                            ▼
                      reconstructed image ──compare──▶ MSE / PSNR / NRMSE
                                                        + error heatmap
```

- **k-space structure**: the center holds low spatial frequencies (overall shape, contrast) and most of the image's energy; the edges hold high spatial frequencies (sharp boundaries, fine texture, noise).
- **A skipped k-space point is treated as a measured zero**, not simply dropped — so the inverse transform doesn't blur the image, it distorts it (ghosting, streaking), corrupting the whole reconstruction at once rather than one region.
- **Acceleration factor `R`**: `R = 4` means only 1/4 of k-space was kept. Higher `R` → faster scan → harder reconstruction.
- **Multi-coil combination**: each coil's k-space is inverse-transformed separately, then combined with root-sum-of-squares, `I = √(Σ_c |I_c|²)`, so every pixel is dominated by the coils that see it best.


### Requirements

- Python 3.x, NumPy
- A modern browser (uses HTML5 Canvas and the Web Audio API for sonification — no plugins needed)

## Usage

1. **Load an image** — upload a photo or an `.h5` multi-coil k-space file.
2. **Pick a sampling pattern** — Cartesian, radial, random, variable-density, or paint your own mask.
3. **Set the acceleration factor** — or use auto-mask to hit a target PSNR/MSE/NRMSE directly.
4. **(Optional) add noise** — to see how acquisition noise compounds with undersampling.
5. **Compare** — view the reconstruction, error heatmap, and live metrics.
6. **(Optional) listen** — open the Sound tab, pick two panels, and compare them by ear.

## Evaluation metrics

| Metric | Meaning | Better is |
|---|---|---|
| **MSE** | Mean squared pixel error | Lower (0 = perfect) |
| **PSNR** | Peak signal-to-noise ratio (dB) | Higher (+6 dB ≈ half the error amplitude) |
| **NRMSE** | RMSE normalized by the image's own intensity range | Lower, comparable across scans |
| **Error heatmap** | `\|original − reconstruction\|` per pixel | Highlights exactly where reconstruction failed |

## Auto-mask

Instead of manually tuning a mask, request a target quality directly:

```
metric = "psnr", target_value = 30, family = "variable_density"
```

The algorithm binary-searches sampling **density** rather than sweeping every possible mask. This works because masks in a family are built by thresholding one fixed score field, so raising density only ever *adds* k-space points — reconstruction error is therefore monotonic in density, which is exactly what bisection needs to converge in `O(log₂(1/precision))` trials instead of a brute-force search.

## Sonification

Any 2D panel (image, k-space, error map) can be converted to audio:

- **Spectral mode** — each image row becomes a fixed pitch (top = high, bottom = low), each column is a moment in time, and brightness sets volume. All 48 pitches play together — a full picture of the panel's structure.
- **Contour mode** — a single voice tracks where the brightness is concentrated column by column, turning the image into a melody. Easier to A/B by ear, but summarizes each column into just two numbers (pitch centroid + average volume), so it can miss detail that spectral mode would reveal.

Full k-space sounds coherent; undersampled k-space sounds like gaps and static; noise adds a haze across all pitches — the same information loss you see, now audible.

## Tech stack

- **Backend**: Python, NumPy (FFT, sampling, metrics, reconstruction), FastAPI
- **Frontend**: HTML5, CSS, JavaScript, Web Audio API

## Course context

This project was built for **Signal and Linear Systems Sessional (CSE220)**, applying 2D Fourier Transform theory to a real imaging modality — demonstrating the trade-off every clinical MRI scan makes between acquisition speed and reconstruction fidelity, and validating that trade-off the way the field actually does: retrospective undersampling of fully-sampled k-space against a known ground truth.

