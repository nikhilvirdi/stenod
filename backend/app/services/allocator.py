"""
Adaptive Memory Allocator (Layer 1 Component).
Mathematically balances system resource limits against Layer 2 predictive intelligence
to assign dynamic priority scores to processes.
Target KPIs: 20%+ load time improvement, 30%+ memory utilization efficiency.
"""

from typing import Dict, List, Any
import math
from app.utils.logger import get_logger

log = get_logger(__name__)

class ProcessState:
    def __init__(self, pid: int, name: str, memory_mb: float, is_foreground: bool = False, is_system: bool = False):
        self.pid = pid
        self.name = name
        self.memory_mb = memory_mb
        self.is_foreground = is_foreground
        self.is_system = is_system
        self.prediction_prob: float = 0.0
        self.priority_score: float = 0.0

class AdaptiveAllocator:
    """
    Computes priority scores for a given set of processes based on context and predictions.
    Replaces static OS OOM-killer heuristics with a proactive, learned policy.
    """
    def __init__(self):
        # Coefficients for mathematical balancing
        # These would ideally be learned or tuned via Bayesian optimization
        self.alpha = 0.6  # Weight for Predictive Intelligence (Layer 2)
        self.beta = 0.3   # Weight for inherent process importance (Foreground/System)
        self.gamma = 0.1  # Penalty weight for resource footprint
        
    def _calculate_base_importance(self, proc: ProcessState) -> float:
        """
        Determines the base system-level importance of a process.
        """
        if proc.is_foreground:
            return 1.0
        if proc.is_system:
            return 0.8
        return 0.1 # Background user process

    def _calculate_resource_penalty(self, proc: ProcessState, total_available_ram_mb: float) -> float:
        """
        Calculates a memory pressure penalty.
        Uses a sigmoid function so that small apps have negligible penalty, 
        but massive apps under high memory pressure are penalized more heavily.
        """
        if total_available_ram_mb <= 0:
            return 1.0
            
        ratio = proc.memory_mb / total_available_ram_mb
        # Sigmoid curve shifted to penalize heavy consumers 
        penalty = 1.0 / (1.0 + math.exp(-10 * (ratio - 0.5)))
        return penalty

    def allocate_priorities(
        self, 
        processes: List[ProcessState], 
        predictions: Dict[str, float], 
        available_ram_mb: float
    ) -> List[ProcessState]:
        """
        Executes the mathematical balancing pass to rank processes.
        """
        for proc in processes:
            # 1. Update prediction probability from Layer 2
            proc.prediction_prob = predictions.get(proc.name, 0.0)
            if proc.is_foreground:
                 # Foreground app implicitly has highest predictive relevance to current moment
                proc.prediction_prob = max(proc.prediction_prob, 0.9)
                
            # 2. Calculate components
            pred_score = self.alpha * proc.prediction_prob
            importance_score = self.beta * self._calculate_base_importance(proc)
            resource_penalty = self.gamma * self._calculate_resource_penalty(proc, available_ram_mb)
            
            # 3. Final Composite Score
            proc.priority_score = pred_score + importance_score - resource_penalty
            
            # Ensure score is within bounded range for downstream mapping
            proc.priority_score = max(0.0, min(1.0, proc.priority_score))

        # Sort processes by priority score descending (highest priority first)
        processes.sort(key=lambda p: p.priority_score, reverse=True)
        
        log.debug(f"Allocated priorities for {len(processes)} processes. Top process: {processes[0].name if processes else 'None'}")
        return processes

    def generate_oom_adjustment_map(self, prioritized_processes: List[ProcessState]) -> Dict[str, int]:
        """
        Maps the calculated priorities to theoretical OOM (Out Of Memory) adjustment scores.
        Lower score = less likely to be killed.
        Example scale: -1000 (OOM unkillable) to 1000 (OOM killable).
        """
        adjustment_map = {}
        for proc in prioritized_processes:
            # Inverse linear mapping: score 1.0 -> -1000, score 0.0 -> 1000
            oom_score = int(1000 - (proc.priority_score * 2000))
            adjustment_map[proc.name] = oom_score
            
        return adjustment_map
