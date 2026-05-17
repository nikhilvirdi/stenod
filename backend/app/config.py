"""
Application configuration module.
Uses pydantic-settings to strictly validate environment variables.
"""

from functools import lru_cache
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import SecretStr


class Settings(BaseSettings):
    """
    Settings definition for Mnemosyne.
    All sensitive values have no defaults and must be provided via .env.
    """
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore"
    )

    # Ollama settings
    OLLAMA_BASE_URL: str
    OLLAMA_MODEL: str
    EMBED_MODEL: str

    # Database settings
    DB_PATH: str
    CHROMA_PATH: str

    # Security settings
    SECRET_KEY: SecretStr
    ALLOWED_ORIGINS: List[str]

    # Application settings
    LOG_LEVEL: str = "INFO"

    # Predictive Engine settings
    PREDICTION_MODEL_PATH: str = "models/prediction_lstm.pt"
    
    # Context Monitor settings
    DEVICE_MONITOR_INTERVAL: int = 5  # seconds


@lru_cache
def get_settings() -> Settings:
    """
    Returns a cached instance of the settings.
    Using lru_cache ensures we only read the .env file once upon first call.
    """
    return Settings()
