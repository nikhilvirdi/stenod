"""
Embeddings service module.
Provides a unified interface for vector generation across the application.
"""

from typing import List
from app.services.ollama import OllamaService
from app.utils.logger import get_logger

log = get_logger(__name__)

class EmbeddingService:
    """
    Handles generation of vector embeddings for episodic memory.
    Wraps OllamaService to maintain abstraction.
    """
    def __init__(self):
        self.ollama = OllamaService()

    async def get_embedding(self, text: str) -> List[float]:
        """
        Convert text to a vector embedding.
        """
        log.debug(f"Generating embedding for text length: {len(text)}")
        return await self.ollama.embed(text)

    async def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for multiple texts.
        Note: Current Ollama API doesn't support batch, so we loop.
        """
        results = []
        for text in texts:
            results.append(await self.get_embedding(text))
        return results
