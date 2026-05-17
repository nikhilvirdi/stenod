"""
Ollama service module for local LLM orchestration.
"""

import httpx
import json
from typing import List, Optional, Dict, Any
from app.config import get_settings
from app.utils.logger import get_logger
from app.utils.errors import ServiceError

log = get_logger(__name__)

class OllamaService:
    """
    Client for interacting with local Ollama instance.
    Handles text generation, structured chat, and vector embeddings.
    """
    def __init__(self):
        settings = get_settings()
        self.base_url = settings.OLLAMA_BASE_URL.rstrip('/')
        self.model = settings.OLLAMA_MODEL
        self.embed_model = settings.EMBED_MODEL
        self.timeout = 60.0 # Generation can take time on consumer hardware

    async def generate(self, prompt: str, system: Optional[str] = None) -> str:
        """
        Generic completion endpoint.
        """
        url = f"{self.base_url}/api/generate"
        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False
        }
        if system:
            payload["system"] = system

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
                return data.get("response", "")
        except httpx.HTTPError as e:
            log.error(f"Ollama generation failed: {str(e)}")
            raise ServiceError(
                message="Failed to generate response from Ollama",
                detail=str(e)
            )

    async def chat(self, messages: List[Dict[str, str]]) -> str:
        """
        Chat completion endpoint for conversational memory.
        """
        url = f"{self.base_url}/api/chat"
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
                return data.get("message", {}).get("content", "")
        except httpx.HTTPError as e:
            log.error(f"Ollama chat failed: {str(e)}")
            raise ServiceError(
                message="Failed to get chat response from Ollama",
                detail=str(e)
            )

    async def embed(self, text: str) -> List[float]:
        """
        Generates vector embeddings for semantic search.
        """
        url = f"{self.base_url}/api/embeddings"
        payload = {
            "model": self.embed_model,
            "prompt": text
        }

        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
                return data.get("embedding", [])
        except httpx.HTTPError as e:
            log.error(f"Ollama embedding failed: {str(e)}")
            raise ServiceError(
                message="Failed to generate embeddings from Ollama",
                detail=str(e)
            )
