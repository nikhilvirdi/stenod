"""
Global response models.
"""

from datetime import datetime
from pydantic import BaseModel, Field


class BaseResponse(BaseModel):
    """
    Base model that all future API responses will inherit from.
    Provides a consistent structure for responses.
    """
    success: bool = Field(default=True, description="Indicates if the operation was successful")


class HealthResponse(BaseResponse):
    """
    Response model for the health check endpoint.
    """
    status: str = Field(description="Current status of the system")
    version: str = Field(description="API version")
    timestamp: datetime = Field(description="Current server timestamp")
