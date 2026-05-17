"""
Tasks routes module.
Provides endpoints for managing agent goals, plans, and task states.
"""

from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from app.db.database import get_db
from app.db.models import AgentTask as AgentTaskModel
from app.memory.task import TaskManager
from app.models.responses import BaseResponse
from app.utils.logger import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/tasks", tags=["Task Memory"])

# --- Request/Response Models ---

class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, description="Goal or subtask title")
    description: str = Field("", description="Detailed instructions, subtasks, or constraints")
    priority: int = Field(0, description="Priority rating (higher is more important)")
    parent_id: Optional[int] = Field(None, description="Optional parent task ID for hierarchical subtasks")

class TaskUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, description="Goal or subtask title")
    description: Optional[str] = Field(None, description="Detailed instructions")
    priority: Optional[int] = Field(None, description="Priority rating")
    status: Optional[str] = Field(None, description="Task status ('pending', 'in_progress', 'completed', 'failed')")
    parent_id: Optional[int] = Field(None, description="Parent task ID")

class TaskItem(BaseModel):
    id: int
    title: str
    description: str
    status: str
    priority: int
    parent_task_id: Optional[int]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class TaskResponse(BaseResponse):
    task: TaskItem

class TaskListResponse(BaseResponse):
    tasks: List[TaskItem]

# --- Routes ---

@router.get("", response_model=TaskListResponse)
async def list_tasks(status_filter: Optional[str] = None, db: Session = Depends(get_db)):
    """
    List all tasks, with optional status filtering.
    """
    log.info(f"API tasks: Listing all tasks (filter status: {status_filter})")
    try:
        query = db.query(AgentTaskModel)
        if status_filter:
            query = query.filter(AgentTaskModel.status == status_filter)
        tasks = query.order_by(AgentTaskModel.priority.desc(), AgentTaskModel.created_at.desc()).all()
        return TaskListResponse(
            success=True,
            tasks=[TaskItem.model_validate(t) for t in tasks]
        )
    except Exception as e:
        log.error(f"API tasks: Failed to retrieve tasks: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve tasks."
        )

@router.post("", response_model=TaskResponse)
async def create_task(task_data: TaskCreate, db: Session = Depends(get_db)):
    """
    Create a new goal or sub-task.
    """
    log.info(f"API tasks: Creating task '{task_data.title}'")
    try:
        manager = TaskManager(db)
        task = manager.create_task(
            title=task_data.title,
            description=task_data.description,
            priority=task_data.priority,
            parent_id=task_data.parent_id
        )
        return TaskResponse(
            success=True,
            task=TaskItem.model_validate(task)
        )
    except Exception as e:
        log.error(f"API tasks: Failed to create task: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create task."
        )

@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(task_id: int, task_data: TaskUpdate, db: Session = Depends(get_db)):
    """
    Update details or status of an existing task.
    """
    log.info(f"API tasks: Patching task ID {task_id}")
    try:
        task = db.query(AgentTaskModel).filter(AgentTaskModel.id == task_id).first()
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"AgentTask with ID {task_id} not found."
            )

        if task_data.title is not None:
            task.title = task_data.title
        if task_data.description is not None:
            task.description = task_data.description
        if task_data.priority is not None:
            task.priority = task_data.priority
        if task_data.status is not None:
            if task_data.status not in ["pending", "in_progress", "completed", "failed"]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid status value '{task_data.status}'. Must be pending, in_progress, completed, or failed."
                )
            task.status = task_data.status
        if task_data.parent_id is not None:
            task.parent_task_id = task_data.parent_id

        db.commit()
        db.refresh(task)

        return TaskResponse(
            success=True,
            task=TaskItem.model_validate(task)
        )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"API tasks: Failed to update task {task_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update task."
        )

@router.delete("/{task_id}", response_model=BaseResponse)
async def delete_task(task_id: int, db: Session = Depends(get_db)):
    """
    Delete a task from the persistent registry.
    """
    log.info(f"API tasks: Deleting task ID {task_id}")
    try:
        manager = TaskManager(db)
        success = manager.delete_task(task_id)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"AgentTask with ID {task_id} not found."
            )
        return BaseResponse(success=True)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"API tasks: Failed to delete task {task_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete task."
        )

