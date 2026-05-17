"""
Task Memory (Layer 3 Component).
Handles the long-term persistence of agent goals, plans, and state transitions using SQLite.
"""

from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from app.db.models import AgentTask as AgentTaskModel
from app.utils.logger import get_logger

log = get_logger(__name__)

class TaskManager:
    """
    Manages structured task tracking for AI agents.
    Allows for hierarchical task planning (parent-child tasks) and state management.
    """
    def __init__(self, db_session: Session):
        self.db = db_session

    def create_task(
        self, 
        title: str, 
        description: str, 
        priority: int = 0, 
        parent_id: Optional[int] = None
    ) -> AgentTaskModel:
        """
        Registers a new goal or sub-task for the agent.
        """
        new_task = AgentTaskModel(
            title=title,
            description=description,
            priority=priority,
            parent_task_id=parent_id,
            status="pending"
        )
        self.db.add(new_task)
        self.db.commit()
        self.db.refresh(new_task)
        
        log.info(f"Created Task {new_task.id}: '{title}' (Parent: {parent_id})")
        return new_task

    def update_status(self, task_id: int, status: str) -> bool:
        """
        Updates the state of a task (pending, in_progress, completed, failed).
        """
        task = self.db.query(AgentTaskModel).filter(AgentTaskModel.id == task_id).first()
        if not task:
            log.warning(f"Attempted to update non-existent task: {task_id}")
            return False
            
        task.status = status
        self.db.commit()
        log.debug(f"Task {task_id} status updated to: {status}")
        return True

    def get_active_tasks(self) -> List[AgentTaskModel]:
        """
        Returns all tasks that are currently pending or in progress.
        """
        return self.db.query(AgentTaskModel).filter(
            AgentTaskModel.status.in_(["pending", "in_progress"])
        ).order_by(AgentTaskModel.priority.desc()).all()

    def get_task_by_id(self, task_id: int) -> Optional[AgentTaskModel]:
        """
        Retrieves a specific task and its metadata.
        """
        return self.db.query(AgentTaskModel).filter(AgentTaskModel.id == task_id).first()

    def get_subtasks(self, parent_id: int) -> List[AgentTaskModel]:
        """
        Retrieves all child tasks for a specific parent goal.
        Useful for breakdown planning.
        """
        return self.db.query(AgentTaskModel).filter(AgentTaskModel.parent_task_id == parent_id).all()

    def delete_task(self, task_id: int) -> bool:
        """
        Removes a task from the persistent registry.
        """
        task = self.db.query(AgentTaskModel).filter(AgentTaskModel.id == task_id).first()
        if task:
            self.db.delete(task)
            self.db.commit()
            log.info(f"Deleted Task {task_id}")
            return True
        return False
