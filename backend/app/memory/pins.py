"""
Instruction Pins (Layer 3 Component).
Handles behavioral constraints and pinned instructions that are injected
directly into the agent's context window.
"""

from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from app.db.models import InstructionPin as InstructionPinModel
from app.utils.logger import get_logger

log = get_logger(__name__)

class InstructionPinManager:
    """
    Manages user-defined custom behaviors and global system constraints (Instruction Pins).
    Provides CRUD operations and compiling a format-ready injection block.
    """
    def __init__(self, db_session: Session):
        self.db = db_session

    def create_pin(self, key: str, content: str, priority: int = 10, is_active: bool = True) -> InstructionPinModel:
        """
        Creates a new instruction pin or updates it if key already exists (upsert).
        """
        existing_pin = self.db.query(InstructionPinModel).filter(InstructionPinModel.key == key).first()
        if existing_pin:
            existing_pin.content = content
            existing_pin.priority = priority
            existing_pin.is_active = is_active
            self.db.commit()
            self.db.refresh(existing_pin)
            log.info(f"Updated Instruction Pin '{key}' (Priority: {priority})")
            return existing_pin

        new_pin = InstructionPinModel(
            key=key,
            content=content,
            priority=priority,
            is_active=is_active
        )
        self.db.add(new_pin)
        self.db.commit()
        self.db.refresh(new_pin)
        log.info(f"Created Instruction Pin {new_pin.id}: '{key}' (Priority: {priority})")
        return new_pin

    def update_pin(
        self, 
        pin_id: int, 
        content: Optional[str] = None, 
        priority: Optional[int] = None, 
        is_active: Optional[bool] = None
    ) -> Optional[InstructionPinModel]:
        """
        Updates an existing instruction pin by ID.
        """
        pin = self.db.query(InstructionPinModel).filter(InstructionPinModel.id == pin_id).first()
        if not pin:
            log.warning(f"Attempted to update non-existent instruction pin: {pin_id}")
            return None

        if content is not None:
            pin.content = content
        if priority is not None:
            pin.priority = priority
        if is_active is not None:
            pin.is_active = is_active

        self.db.commit()
        self.db.refresh(pin)
        log.debug(f"Instruction Pin {pin_id} updated.")
        return pin

    def get_active_pins(self) -> List[InstructionPinModel]:
        """
        Retrieves all currently active behavioral constraints.
        """
        return self.db.query(InstructionPinModel).filter(
            InstructionPinModel.is_active == True
        ).order_by(InstructionPinModel.priority.desc()).all()

    def get_pin_by_key(self, key: str) -> Optional[InstructionPinModel]:
        """
        Retrieves a pin by its unique string key.
        """
        return self.db.query(InstructionPinModel).filter(InstructionPinModel.key == key).first()

    def delete_pin(self, pin_id: int) -> bool:
        """
        Removes a pin from the database.
        """
        pin = self.db.query(InstructionPinModel).filter(InstructionPinModel.id == pin_id).first()
        if pin:
            self.db.delete(pin)
            self.db.commit()
            log.info(f"Deleted Instruction Pin {pin_id}")
            return True
        return False

    def compile_instruction_block(self) -> str:
        """
        Compiles all active instruction pins into a formatted prompt string
        for direct system injection. Pinned rules are ordered by priority descending.
        """
        active_pins = self.get_active_pins()
        if not active_pins:
            return ""

        block_parts = ["[BEHAVIORAL CONSTRAINTS & PINNED RULES]"]
        for pin in active_pins:
            block_parts.append(f"- {pin.key.upper()}: {pin.content}")
        block_parts.append("[END CONSTRAINTS]")
        
        return "\n".join(block_parts)
