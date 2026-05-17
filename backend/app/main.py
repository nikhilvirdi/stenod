"""
Main FastAPI application setup.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.utils.logger import setup_logger, get_logger
from app.utils.errors import MnemosyneException
from app.api.routes.health import router as health_router
from app.api.routes.chat import router as chat_router
from app.api.routes.pins import router as pins_router
from app.api.routes.tasks import router as tasks_router
from app.api.routes.memory import router as memory_router


# Initialize logging before creating the app
setup_logger()
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager for startup and shutdown events.
    Replaces older @app.on_event decorators.
    """
    log.info("Starting up Mnemosyne API...")
    
    # Initialize SQLite Database tables
    try:
        from app.db.database import engine, Base
        import app.db.models  # Load models to register them with Base
        Base.metadata.create_all(bind=engine)
        log.info("Database tables initialized successfully.")
    except Exception as e:
        log.error(f"Failed to initialize database: {e}")
        
    # Start Proactive Suggestions background scheduler
    try:
        from app.agents.proactive import ProactiveAgent
        proactive_agent = ProactiveAgent()
        proactive_agent.start(interval_seconds=30)
        app.state.proactive_agent = proactive_agent
        log.info("Proactive Agent background scheduler started successfully.")
    except Exception as e:
        log.error(f"Failed to start Proactive Agent background scheduler: {e}")
        
    yield
    log.info("Shutting down Mnemosyne API...")
    
    # Stop Proactive Suggestions background scheduler
    if hasattr(app.state, "proactive_agent"):
        try:
            app.state.proactive_agent.stop()
            log.info("Proactive Agent background scheduler stopped successfully.")
        except Exception as e:
            log.error(f"Failed to stop Proactive Agent background scheduler: {e}")


def create_app() -> FastAPI:
    """
    Application factory pattern.
    """
    settings = get_settings()
    
    app = FastAPI(
        title="Mnemosyne Memory OS",
        description="Persistent memory infrastructure for agentic AI systems.",
        version="0.1.0",
        lifespan=lifespan
    )

    # Explicit CORS configuration (no wildcards)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register Routers
    app.include_router(health_router)
    app.include_router(chat_router)
    app.include_router(pins_router)
    app.include_router(tasks_router)
    app.include_router(memory_router)

    # Global exception handler for custom exceptions
    @app.exception_handler(MnemosyneException)
    async def mnemosyne_exception_handler(request: Request, exc: MnemosyneException):
        """
        Catches any custom MnemosyneException, logs the full detail securely internally,
        and returns a safe generic message to the client.
        """
        log.error(f"MnemosyneException | Code: {exc.error_code} | Msg: {exc.message} | Detail: {exc.detail}")
        
        status_code = 400
        if exc.error_code == "NOT_FOUND":
            status_code = 404
        elif exc.error_code in ["SERVICE_ERROR", "DATABASE_ERROR"]:
            status_code = 500
            
        return JSONResponse(
            status_code=status_code,
            content={
                "success": False,
                "error": {
                    "code": exc.error_code,
                    "message": exc.message
                }
            }
        )

    # Global exception handler for unhandled exceptions
    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        """
        Fallback for unexpected errors to ensure nothing leaks.
        """
        log.exception(f"Unhandled server error: {str(exc)}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {
                    "code": "INTERNAL_SERVER_ERROR",
                    "message": "An unexpected internal server error occurred."
                }
            }
        )

    return app


app = create_app()
