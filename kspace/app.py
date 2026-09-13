from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from routes import upload
from routes import pipeline

app = FastAPI(
    title="MRI k-Space Reconstruction Simulator"
)

app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static"
)

templates = Jinja2Templates(
    directory="templates"
)

app.include_router(upload.router)
app.include_router(pipeline.router)


@app.get("/")
async def home(request: Request):
   return templates.TemplateResponse(
   request=request,
   name="index.html"
   )