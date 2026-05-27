from typing import Optional, List
from datetime import datetime
from enum import Enum
from sqlmodel import SQLModel, Field, Relationship
import uuid


def generate_uuid() -> str:
    return str(uuid.uuid4())


# ─── Enums ────────────────────────────────────────────────────────────────────

class ProjectStatus(str, Enum):
    DRAFT = "draft"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class JobStatus(str, Enum):
    QUEUED = "queued"
    SFM = "sfm"           # Global Structure from Motion
    SPLITTING = "splitting"
    DENSE = "dense"       # Dense point cloud / submodel processing
    MERGING = "merging"
    INDEXING = "indexing" # PotreeConverter indexing
    COMPLETED = "completed"
    FAILED = "failed"


class ProcessingPreset(str, Enum):
    FAST_PREVIEW = "fast_preview"
    SURVEY_GRADE = "survey_grade"
    HIGH_FIDELITY = "high_fidelity"


# ─── GCP ──────────────────────────────────────────────────────────────────────

class GCPPoint(SQLModel, table=True):
    __tablename__ = "gcp_points"
    id: Optional[int] = Field(default=None, primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    label: str
    x: float   # Easting
    y: float   # Northing
    z: float   # Elevation
    pixel_x: Optional[float] = None
    pixel_y: Optional[float] = None
    image_name: Optional[str] = None

    # Phase 3: GCP accuracy results (populated after job completes)
    error_x: Optional[float] = None      # Reprojection error X (m)
    error_y: Optional[float] = None      # Reprojection error Y (m)
    error_z: Optional[float] = None      # Reprojection error Z (m)
    error_total: Optional[float] = None  # Total RMSE (m)

    project: Optional["Project"] = Relationship(back_populates="gcps")


# ─── Output ───────────────────────────────────────────────────────────────────

class JobOutput(SQLModel, table=True):
    __tablename__ = "job_outputs"
    id: Optional[int] = Field(default=None, primary_key=True)
    job_id: str = Field(foreign_key="jobs.id", index=True)
    output_type: str  # "orthomosaic", "point_cloud", "mesh", "dsm", "report"
    file_path: str
    file_size_bytes: Optional[int] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

    job: Optional["Job"] = Relationship(back_populates="outputs")


# ─── Job ──────────────────────────────────────────────────────────────────────

class Job(SQLModel, table=True):
    __tablename__ = "jobs"
    id: str = Field(default_factory=generate_uuid, primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    status: JobStatus = Field(default=JobStatus.QUEUED)
    preset: ProcessingPreset = Field(default=ProcessingPreset.SURVEY_GRADE)
    nodeodm_task_id: Optional[str] = None
    celery_task_id: Optional[str] = None
    progress: float = Field(default=0.0)      # 0-100
    current_step: Optional[str] = None
    total_images: int = Field(default=0)
    split_count: int = Field(default=0)
    error_message: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)

    # Phase 3: custom ODM options as JSON string (e.g. '{"pc-quality":"ultra"}')
    custom_options: Optional[str] = None

    # Phase 3: GCP accuracy results from parsed report
    gcp_rmse_x: Optional[float] = None   # Overall X RMSE across all GCPs (m)
    gcp_rmse_y: Optional[float] = None
    gcp_rmse_z: Optional[float] = None
    gcp_rmse_total: Optional[float] = None

    project: Optional["Project"] = Relationship(back_populates="jobs")
    outputs: List[JobOutput] = Relationship(back_populates="job", sa_relationship_kwargs={"cascade": "all, delete-orphan"})


# ─── Project ──────────────────────────────────────────────────────────────────

class Project(SQLModel, table=True):
    __tablename__ = "projects"
    id: str = Field(default_factory=generate_uuid, primary_key=True)
    name: str
    description: Optional[str] = None
    status: ProjectStatus = Field(default=ProjectStatus.DRAFT)
    coordinate_system: Optional[str] = None  # e.g. "EPSG:4326"
    image_count: int = Field(default=0)
    image_dir: Optional[str] = None          # Staging directory for raw images
    output_dir: Optional[str] = None         # Job output directory
    area_acres: Optional[float] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    # Phase 3: RTK/PPK accuracy configuration
    rtk_accuracy_h: Optional[float] = None   # Horizontal GPS accuracy (m), e.g. 0.03
    rtk_accuracy_v: Optional[float] = None   # Vertical GPS accuracy (m), e.g. 0.05
    rtk_mode: Optional[str] = None           # "rtk", "ppk", "none"

    # Phase 4: EXIF bounding box for map mini-preview
    bbox_min_lat: Optional[float] = None
    bbox_max_lat: Optional[float] = None
    bbox_min_lon: Optional[float] = None
    bbox_max_lon: Optional[float] = None
    area_km2: Optional[float] = None         # Estimated coverage area

    jobs: List[Job] = Relationship(back_populates="project", sa_relationship_kwargs={"cascade": "all, delete-orphan"})
    gcps: List[GCPPoint] = Relationship(back_populates="project", sa_relationship_kwargs={"cascade": "all, delete-orphan"})
