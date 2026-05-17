"""
Pins routes module.
Provides endpoints for managing user-defined instruction pins.
"""

from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from app.db.database import get_db
from app.db.models import InstructionPin as InstructionPinModel
from app.memory.pins import InstructionPinManager
from app.models.responses import BaseResponse
from app.utils.logger import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/pins", tags=["Instruction Pins"])

# --- Request/Response Models ---

class PinCreate(BaseModel):
    key: str = Field(..., min_length=1, description="Unique snake_case identifier for the instruction pin")
    content: str = Field(..., min_length=1, description="Behavioral constraint or instruction text")
    priority: int = Field(10, ge=0, description="Priority weight (higher priority is injected first)")
    is_active: bool = Field(True, description="Whether the instruction pin is active")

class PinUpdate(BaseModel):
    content: Optional[str] = Field(None, min_length=1, description="Constraint or instruction text")
    priority: Optional[int] = Field(None, ge=0, description="Priority weight")
    is_active: Optional[bool] = Field(None, description="Whether the instruction pin is active")

class PinItem(BaseModel):
    id: int
    key: str
    content: str
    priority: int
    is_active: bool

    class Config:
        from_attributes = True

class PinResponse(BaseResponse):
    pin: PinItem

class PinsListResponse(BaseResponse):
    pins: List[PinItem]

# --- Routes ---

@router.get("", response_model=PinsListResponse)
async def list_pins(db: Session = Depends(get_db)):
    """
    List all instruction pins in the database.
    """
    log.info("API pins: Listing all instruction pins")
    try:
        pins = db.query(InstructionPinModel).all()
        return PinsListResponse(
            success=True,
            pins=[PinItem.model_validate(p) for p in pins]
        )
    except Exception as e:
        log.error(f"API pins: Failed to retrieve instruction pins: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve instruction pins."
        )

@router.post("", response_model=PinResponse)
async def create_pin(pin_data: PinCreate, db: Session = Depends(get_db)):
    """
    Create a new instruction pin or updates an existing one if the key already exists (upsert).
    """
    log.info(f"API pins: Creating or upserting instruction pin for key '{pin_data.key}'")
    try:
        manager = InstructionPinManager(db)
        pin = manager.create_pin(
            key=pin_data.key,
            content=pin_data.content,
            priority=pin_data.priority,
            is_active=pin_data.is_active
        )
        return PinResponse(
            success=True,
            pin=PinItem.model_validate(pin)
        )
    except Exception as e:
        log.error(f"API pins: Failed to create or upsert instruction pin: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create or update the instruction pin."
        )

@router.patch("/{pin_id}", response_model=PinResponse)
async def update_pin(pin_id: int, pin_data: PinUpdate, db: Session = Depends(get_db)):
    """
    Update details of an existing instruction pin.
    """
    log.info(f"API pins: Patching instruction pin ID {pin_id}")
    try:
        manager = InstructionPinManager(db)
        pin = manager.update_pin(
            pin_id=pin_id,
            content=pin_data.content,
            priority=pin_data.priority,
            is_active=pin_data.is_active
        )
        if not pin:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"InstructionPin with ID {pin_id} not found."
            )
        return PinResponse(
            success=True,
            pin=PinItem.model_validate(pin)
        )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"API pins: Failed to patch instruction pin {pin_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update instruction pin."
        )

@router.delete("/{pin_id}", response_model=BaseResponse)
async def delete_pin(pin_id: int, db: Session = Depends(get_db)):
    """
    Delete an instruction pin from the database.
    """
    log.info(f"API pins: Deleting instruction pin ID {pin_id}")
    try:
        manager = InstructionPinManager(db)
        success = manager.delete_pin(pin_id)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"InstructionPin with ID {pin_id} not found."
            )
        return BaseResponse(success=True)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"API pins: Failed to delete instruction pin {pin_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete instruction pin."
        )

