from sqlmodel import SQLModel, create_engine, Session
from config import DATABASE_URL
from models import Project, Job, GCPPoint, JobOutput  # noqa: F401 — registers tables

engine = create_engine(DATABASE_URL, echo=False)


def init_db():
    """Create all tables if they don't exist."""
    SQLModel.metadata.create_all(engine)


def get_session():
    """FastAPI dependency: yield a database session."""
    with Session(engine) as session:
        yield session
