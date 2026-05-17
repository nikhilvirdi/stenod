"""
Conflict Detection Subsystem (Layer 3 Component).
Identifies and registers contradictions between new and existing semantic memories.
"""

import datetime
from typing import Optional, List
from sqlalchemy.orm import Session
from app.db.models import SemanticMemory, MemoryConflict
from app.utils.logger import get_logger

log = get_logger(__name__)

class ConflictDetector:
    """
    Detects contradictions between incoming semantic memory facts and already stored facts.
    """
    def __init__(self, db_session: Session):
        self.db = db_session

    def check_and_register_conflict(self, category: str, key: str, new_value: str) -> Optional[MemoryConflict]:
        """
        Checks if an incoming fact contradicts an existing fact.
        If a conflict is detected, it is logged in the memory_conflicts table.
        Returns the MemoryConflict instance if created, else None.
        """
        # Find existing fact with the same key
        existing_fact = self.db.query(SemanticMemory).filter(SemanticMemory.key == key).first()
        
        if not existing_fact:
            return None
            
        # Standardize and compare values (simple string contradiction check)
        if existing_fact.value.strip().lower() != new_value.strip().lower():
            log.info(f"Conflict detected for key '{key}': Existing = '{existing_fact.value}' | New = '{new_value}'")
            
            # Check if this conflict is already registered and unresolved
            existing_conflict = self.db.query(MemoryConflict).filter(
                MemoryConflict.key == key,
                MemoryConflict.resolved == False
            ).first()
            
            if existing_conflict:
                # Update the registered new value if it has changed again
                existing_conflict.new_value = new_value
                self.db.commit()
                return existing_conflict
                
            conflict = MemoryConflict(
                key=key,
                existing_value=existing_fact.value,
                new_value=new_value,
                category=category,
                resolved=False
            )
            self.db.add(conflict)
            self.db.commit()
            self.db.refresh(conflict)
            return conflict
            
        return None

    def resolve_conflict(self, conflict_id: int, keep_existing: bool) -> bool:
        """
        Resolves a memory conflict.
        If keep_existing is True, we discard the new value.
        If keep_existing is False, we overwrite the existing fact with the new value.
        """
        conflict = self.db.query(MemoryConflict).filter(MemoryConflict.id == conflict_id).first()
        if not conflict:
            log.warning(f"Conflict {conflict_id} not found.")
            return False
            
        if conflict.resolved:
            log.warning(f"Conflict {conflict_id} is already resolved.")
            return True

        if not keep_existing:
            # Overwrite semantic fact with the new value
            fact = self.db.query(SemanticMemory).filter(SemanticMemory.key == conflict.key).first()
            if fact:
                fact.value = conflict.new_value
                fact.confidence = 1.0  # Reset confidence upon resolution
                log.info(f"Resolved conflict {conflict_id} by accepting new value: {conflict.new_value}")
            else:
                # If original fact was somehow deleted, recreate it
                new_fact = SemanticMemory(
                    key=conflict.key,
                    value=conflict.new_value,
                    category=conflict.category,
                    confidence=1.0
                )
                self.db.add(new_fact)
                log.info(f"Resolved conflict {conflict_id} by creating new fact: {conflict.new_value}")
        else:
            log.info(f"Resolved conflict {conflict_id} by keeping existing value: {conflict.existing_value}")

        conflict.resolved = True
        conflict.resolved_at = datetime.datetime.utcnow()
        self.db.commit()
        return True

    def get_unresolved_conflicts(self) -> List[MemoryConflict]:
        """
        Retrieves all unresolved memory conflicts.
        """
        return self.db.query(MemoryConflict).filter(MemoryConflict.resolved == False).all()
