"""
Structured logger for Mnemosyne.
Provides a single loguru-based logger instance.
"""

import sys
from loguru import logger
from app.config import get_settings

def setup_logger():
    """
    Configures the loguru logger.
    Removes default handlers and adds our structured format.
    """
    settings = get_settings()
    
    # Remove default handler
    logger.remove()
    
    # Add console handler
    logger.add(
        sys.stderr,
        format="<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
        level=settings.LOG_LEVEL,
        enqueue=True,
    )

def get_logger(name: str):
    """
    Returns a logger bound with the specific module name.
    """
    return logger.bind(module=name)
