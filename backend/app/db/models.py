"""
SQLAlchemy models for Mnemosyne's three-layer persistent memory system.
"""

from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, ForeignKey
from sqlalchemy.sql import func
from app.db.database import Base

class ContextLog(Base):
    """
    Diagnostic logs of user context state. 
    Feeds the Predictive Intelligence Engine (Layer 2).
    """
    __tablename__ = "context_logs"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    app = Column(String, index=True)
    hour = Column(Integer)
    day = Column(Integer)
    battery = Column(Float)
    charging = Column(Boolean)
    ram_percent = Column(Float)
    cpu_percent = Column(Float)
    is_online = Column(Boolean)

class SemanticMemory(Base):
    """
    Extracted facts and preferences (Layer 3 - Semantic Memory).
    Examples: 'User prefers dark mode', 'User works at Google'.
    """
    __tablename__ = "semantic_memory"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, index=True, unique=True)
    value = Column(Text)
    category = Column(String, index=True) # e.g., 'preference', 'entity', 'event'
    confidence = Column(Float, default=1.0)
    last_updated = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

class AgentTask(Base):
    """
    Task state management for AI agents (Layer 3 - Task Memory).
    """
    __tablename__ = "agent_tasks"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    description = Column(Text)
    status = Column(String, default="pending") # pending, in_progress, completed, failed
    priority = Column(Integer, default=0)
    parent_task_id = Column(Integer, ForeignKey("agent_tasks.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

class InstructionPin(Base):
    """
    Fixed behavioral constraints or user-defined 'pinned' instructions (Layer 3 - Working Memory context).
    """
    __tablename__ = "instruction_pins"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, index=True, unique=True)
    content = Column(Text)
    is_active = Column(Boolean, default=True)
    priority = Column(Integer, default=10) # Higher numbers = higher priority injection

class MemoryConflict(Base):
    """
    Conflict registry for storing contradictions between new and existing memories.
    Queued for user or agent resolution.
    """
    __tablename__ = "memory_conflicts"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, index=True)
    existing_value = Column(Text)
    new_value = Column(Text)
    category = Column(String)
    resolved = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    resolved_at = Column(DateTime(timezone=True), nullable=True)

class ProactiveSuggestion(Base):
    """
    Proactive suggestions generated in the background by the Proactive Agent.
    """
    __tablename__ = "proactive_suggestions"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    suggestion_text = Column(Text, nullable=False)
    triggered_context = Column(Text, nullable=True)
    acknowledged = Column(Boolean, default=False)
    resolved = Column(Boolean, default=False)

