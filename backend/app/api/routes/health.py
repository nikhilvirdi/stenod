"""
Health check routes.
"""

from datetime import datetime
from fastapi import APIRouter
from app.models.responses import HealthResponse

router = APIRouter(prefix="/health", tags=["Health"])

@router.get("", response_model=HealthResponse)
async def health_check():
    """
    Basic health check endpoint.
    Returns the system status, API version, and server timestamp.
    """
    return HealthResponse(
        status="healthy",
        version="0.1.0",
        timestamp=datetime.utcnow()
    )
