"""
Custom exception definitions.
Centralizes error handling to prevent generic 500s from leaking internal state.
"""

from typing import Optional, Any


class MnemosyneException(Exception):
    """Base exception for all custom Mnemosyne errors."""
    def __init__(self, message: str, error_code: str, detail: Optional[Any] = None):
        self.message = message
        self.error_code = error_code
        self.detail = detail
        super().__init__(self.message)


class NotFoundError(MnemosyneException):
    """Raised when a requested resource is not found."""
    def __init__(self, message: str, detail: Optional[Any] = None):
        super().__init__(message, error_code="NOT_FOUND", detail=detail)


class ValidationError(MnemosyneException):
    """Raised when input validation fails in the business logic."""
    def __init__(self, message: str, detail: Optional[Any] = None):
        super().__init__(message, error_code="VALIDATION_ERROR", detail=detail)


class ServiceError(MnemosyneException):
    """Raised when an external service (like Ollama or Chroma) fails."""
    def __init__(self, message: str, detail: Optional[Any] = None):
        super().__init__(message, error_code="SERVICE_ERROR", detail=detail)


class DatabaseError(MnemosyneException):
    """Raised when a database operation fails."""
    def __init__(self, message: str, detail: Optional[Any] = None):
        super().__init__(message, error_code="DATABASE_ERROR", detail=detail)
