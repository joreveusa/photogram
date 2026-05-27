from celery import Celery
from config import REDIS_URL

celery_app = Celery(
    "photoforge",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks.pipeline"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,  # Process one chunk at a time to manage RAM
)
