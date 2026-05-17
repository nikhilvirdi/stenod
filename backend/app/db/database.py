"""
Database management module.
Sets up the SQLAlchemy engine and session factory for SQLite.
"""

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from app.config import get_settings

settings = get_settings()

# SQLite engine configuration
# check_same_thread=False is required for SQLite with FastAPI
engine = create_engine(
    f"sqlite:///./{settings.DB_PATH}", 
    connect_args={"check_same_thread": False}
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    """
    Dependency to provide a database session to FastAPI routes.
    Ensures the session is closed after the request.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
