"""
Memory routes module.
Provides endpoints for managing cognitive layers (Semantic, Episodic, Working, and Memory Conflict resolution).
"""

from typing import List, Dict, Any, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from app.db.database import get_db
from app.db.models import MemoryConflict as MemoryConflictModel
from app.memory.semantic import SemanticMemoryManager
from app.memory.conflict import ConflictDetector
from app.memory.episodic import EpisodicMemory
from app.memory.working import WorkingMemory
from app.models.responses import BaseResponse
from app.utils.logger import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/memory", tags=["Memory Router & Cognitive Tiers"])

# --- Request/Response Models ---

class SemanticFactItem(BaseModel):
    key: str = Field(..., description="Unique snake_case identifier for the fact")
    value: str = Field(..., description="Fact or preference content")
    category: str = Field(..., description="Category of the fact ('preference', 'fact', 'entity')")
    confidence: float = Field(..., description="Confidence score of the extraction")

class SemanticListResponse(BaseResponse):
    facts: List[SemanticFactItem]

class SemanticExtractRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Raw unstructured text to extract facts from")

class SemanticExtractResponse(BaseResponse):
    extracted_facts: List[Dict[str, Any]]

class ConflictItem(BaseModel):
    id: int
    key: str
    existing_value: str
    new_value: str
    category: str
    resolved: bool
    created_at: datetime
    resolved_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class ConflictsListResponse(BaseResponse):
    conflicts: List[ConflictItem]

class ConflictResolveRequest(BaseModel):
    keep_existing: bool = Field(..., description="If True, retains the existing fact. If False, overwrites it with the new fact.")

class EpisodicSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Search query string")
    limit: Optional[int] = Field(5, ge=1, description="Maximum number of relevant past episodes to return")

class EpisodeItem(BaseModel):
    id: str
    document: str
    metadata: Dict[str, Any]
    distance: float

class EpisodicSearchResponse(BaseResponse):
    results: List[EpisodeItem]

class EpisodicStoreRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Raw conversation summary or event detail to store")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Metadata dictionary to store alongside the episode")

class EpisodicStoreResponse(BaseResponse):
    episode_id: str

class WorkingMemoryMessage(BaseModel):
    role: str
    content: str
    timestamp: Optional[str] = None

class WorkingMemoryStatsResponse(BaseResponse):
    session_id: str
    messages: List[WorkingMemoryMessage]
    current_tokens: int
    max_tokens: int
    capacity_percent: float

# --- Routes ---

# 1. Semantic Memory Endpoints
@router.get("/semantic", response_model=SemanticListResponse)
async def list_semantic_facts(category: Optional[str] = None, db: Session = Depends(get_db)):
    """
    Retrieve persistent user profile facts, with optional category filtering.
    """
    log.info(f"API memory: Listing semantic facts (category filter: {category})")
    try:
        manager = SemanticMemoryManager(db)
        if category:
            facts = manager.get_facts_by_category(category)
            facts_with_category = [
                SemanticFactItem(
                    key=f["key"],
                    value=f["value"],
                    category=category,
                    confidence=f.get("confidence", 1.0)
                )
                for f in facts
            ]
        else:
            facts = manager.get_all_facts()
            facts_with_category = [
                SemanticFactItem(
                    key=f["key"],
                    value=f["value"],
                    category=f["category"],
                    confidence=f.get("confidence", 1.0)
                )
                for f in facts
            ]
        return SemanticListResponse(success=True, facts=facts_with_category)
    except Exception as e:
        log.error(f"API memory: Failed to retrieve semantic facts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve semantic facts."
        )

@router.post("/semantic/extract", response_model=SemanticExtractResponse)
async def extract_semantic_facts(request: SemanticExtractRequest, db: Session = Depends(get_db)):
    """
    Manually trigger semantic fact extraction from arbitrary user text.
    """
    log.info("API memory: Manually triggering semantic fact extraction")
    try:
        manager = SemanticMemoryManager(db)
        extracted = await manager.extract_and_store(request.text)
        return SemanticExtractResponse(success=True, extracted_facts=extracted)
    except Exception as e:
        log.error(f"API memory: Failed to extract semantic facts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to extract semantic facts."
        )

# 2. Conflict Resolution Endpoints
@router.get("/conflicts", response_model=ConflictsListResponse)
async def list_conflicts(db: Session = Depends(get_db)):
    """
    Retrieve all unresolved memory conflicts.
    """
    log.info("API memory: Listing unresolved conflicts")
    try:
        detector = ConflictDetector(db)
        conflicts = detector.get_unresolved_conflicts()
        return ConflictsListResponse(
            success=True,
            conflicts=[ConflictItem.model_validate(c) for c in conflicts]
        )
    except Exception as e:
        log.error(f"API memory: Failed to retrieve unresolved conflicts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve unresolved conflicts."
        )

@router.post("/conflicts/{conflict_id}/resolve", response_model=BaseResponse)
async def resolve_conflict(conflict_id: int, request: ConflictResolveRequest, db: Session = Depends(get_db)):
    """
    Resolve a specific memory contradiction by keeping the existing value or updating it.
    """
    log.info(f"API memory: Resolving conflict {conflict_id} (keep_existing: {request.keep_existing})")
    try:
        detector = ConflictDetector(db)
        # Check if conflict exists first
        conflict = db.query(MemoryConflictModel).filter(MemoryConflictModel.id == conflict_id).first()
        if not conflict:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Memory conflict with ID {conflict_id} not found."
            )
        
        success = detector.resolve_conflict(conflict_id, request.keep_existing)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to resolve conflict {conflict_id}. It may already be resolved."
            )
        return BaseResponse(success=True)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"API memory: Failed to resolve conflict {conflict_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to resolve memory conflict."
        )

# 3. Episodic Memory Endpoints
@router.post("/episodic/search", response_model=EpisodicSearchResponse)
async def search_episodes(request: EpisodicSearchRequest):
    """
    Perform a vector similarity search across Episodic Memory.
    """
    log.info(f"API memory: Searching episodic memory with query '{request.query}'")
    try:
        episodic = EpisodicMemory()
        results = await episodic.search_episodes(request.query, limit=request.limit)
        
        formatted_results = []
        for r in results:
            formatted_results.append(EpisodeItem(
                id=r["id"],
                document=r["document"],
                metadata=r["metadata"],
                distance=r["distance"]
            ))
            
        return EpisodicSearchResponse(success=True, results=formatted_results)
    except Exception as e:
        log.error(f"API memory: Failed to search episodic memory: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to search episodic memory."
        )

@router.post("/episodic", response_model=EpisodicStoreResponse)
async def store_episode(request: EpisodicStoreRequest):
    """
    Store a raw episode in the ChromaDB vector database.
    """
    log.info("API memory: Storing a new episodic memory")
    try:
        episodic = EpisodicMemory()
        episode_id = await episodic.store_episode(request.text, request.metadata)
        if not episode_id:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to store episode in vector database."
            )
        return EpisodicStoreResponse(success=True, episode_id=episode_id)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"API memory: Failed to store episodic memory: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to store episodic memory."
        )

# 4. Working Memory Endpoints
@router.get("/working", response_model=WorkingMemoryStatsResponse)
async def get_working_memory(session_id: Optional[str] = None):
    """
    Retrieve messages, token count, capacity, and statistics for working memory.
    """
    log.info(f"API memory: Fetching working memory stats for session {session_id}")
    try:
        working = WorkingMemory(session_id=session_id)
        
        messages = []
        for m in working.messages:
            messages.append(WorkingMemoryMessage(
                role=m["role"],
                content=m["content"],
                timestamp=m.get("timestamp")
            ))
            
        capacity_percent = (working.current_tokens / working.max_tokens) * 100.0 if working.max_tokens > 0 else 0.0
        
        return WorkingMemoryStatsResponse(
            success=True,
            session_id=working.session_id,
            messages=messages,
            current_tokens=working.current_tokens,
            max_tokens=working.max_tokens,
            capacity_percent=round(capacity_percent, 2)
        )
    except Exception as e:
        log.error(f"API memory: Failed to retrieve working memory: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve working memory."
        )

@router.delete("/working", response_model=BaseResponse)
async def clear_working_memory(session_id: Optional[str] = None):
    """
    Wipe the working memory buffer clean for a session.
    """
    log.info(f"API memory: Clearing working memory for session {session_id}")
    try:
        working = WorkingMemory(session_id=session_id)
        working.clear()
        return BaseResponse(success=True)
    except Exception as e:
        log.error(f"API memory: Failed to clear working memory: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to clear working memory."
        )
