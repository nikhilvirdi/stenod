"""
Episodic Memory (Layer 3 Component).
Handles long-term retrieval of specific past events and conversation summaries
using ChromaDB vector similarity search.
"""

import uuid
import datetime
import chromadb
from typing import List, Dict, Any, Optional
from app.config import get_settings
from app.services.embeddings import EmbeddingService
from app.utils.logger import get_logger

log = get_logger(__name__)

class EpisodicMemory:
    """
    Vector database integration for storing and recalling episodic memories.
    Uses ChromaDB for persistence and the EmbeddingService for text vectorization.
    """
    def __init__(self, collection_name: str = "episodes"):
        self.settings = get_settings()
        self.embedder = EmbeddingService()
        
        # Initialize ChromaDB client pointing to persistent storage
        try:
            self.client = chromadb.PersistentClient(path=f"./{self.settings.CHROMA_PATH}")
            self.collection = self.client.get_or_create_collection(
                name=collection_name,
                metadata={"hnsw:space": "cosine"} # Cosine similarity usually best for text
            )
            log.info(f"Initialized Episodic Memory (Collection: {collection_name})")
        except Exception as e:
            log.error(f"Failed to initialize ChromaDB: {e}")
            raise

    async def store_episode(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        """
        Embeds and stores a new episodic memory (e.g., a summarized conversation chunk).
        """
        episode_id = str(uuid.uuid4())
        timestamp = datetime.datetime.utcnow().isoformat()
        
        meta = metadata or {}
        meta["timestamp"] = timestamp
        meta["type"] = "episode"

        try:
            # Generate embedding via Ollama
            vector = await self.embedder.get_embedding(text)
            
            # Store in Chroma
            self.collection.add(
                ids=[episode_id],
                embeddings=[vector],
                documents=[text],
                metadatas=[meta]
            )
            log.debug(f"Stored episode {episode_id}")
            return episode_id
        except Exception as e:
            log.error(f"Failed to store episode in ChromaDB: {e}")
            # Do not crash the agent if memory save fails
            return ""

    async def search_episodes(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """
        Searches for past episodes similar to the given query.
        """
        try:
            # Embed the search query
            query_vector = await self.embedder.get_embedding(query)
            
            # Query Chroma
            results = self.collection.query(
                query_embeddings=[query_vector],
                n_results=limit,
                include=["documents", "metadatas", "distances"]
            )
            
            formatted_results = []
            
            # Chroma returns lists of lists since it supports batch querying
            if results["ids"] and len(results["ids"]) > 0:
                for i in range(len(results["ids"][0])):
                    formatted_results.append({
                        "id": results["ids"][0][i],
                        "document": results["documents"][0][i],
                        "metadata": results["metadatas"][0][i],
                        "distance": results["distances"][0][i] # Lower is more similar in Cosine space
                    })
                    
            return formatted_results
            
        except Exception as e:
            log.error(f"Failed to search episodes in ChromaDB: {e}")
            return []
