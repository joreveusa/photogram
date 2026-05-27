import os
from dotenv import load_dotenv

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
NODEODM_URL = os.getenv("NODEODM_URL", "http://localhost:3000")
OUTPUT_DIR = os.getenv("OUTPUT_DIR", r"S:\Photogram\outputs")
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{OUTPUT_DIR}/photoforge.db")

# Ensure output directory exists
os.makedirs(OUTPUT_DIR, exist_ok=True)
