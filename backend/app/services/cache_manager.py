"""
Adaptive Cache Manager (Layer 1 Component).
Implements a hybrid eviction policy using LRU, LFU, Predictive weights, and Thrashing detection.
Target KPI: >= 85% cache hit rate and 50% memory thrashing reduction.
"""

import time
from typing import Dict, Any, List, Optional
from app.utils.logger import get_logger

log = get_logger(__name__)

class CacheItemMetadata:
    def __init__(self, key: str, size: int = 1):
        self.key = key
        self.size = size
        self.access_count: int = 1
        self.last_accessed: float = time.time()
        self.predictive_weight: float = 1.0  # From Layer 2
        self.thrash_count: int = 0

class AdaptiveCacheManager:
    """
    Manages in-memory cache eviction dynamically.
    Instead of standard LRU, items are scored based on multiple dimensions.
    """
    def __init__(self, max_capacity: int = 1000, thrash_window_sec: float = 60.0):
        self.max_capacity = max_capacity
        self.current_size = 0
        self.thrash_window_sec = thrash_window_sec
        
        self.cache: Dict[str, Any] = {}
        self.metadata: Dict[str, CacheItemMetadata] = {}
        
        # Tracks recently evicted items to detect thrashing
        # {key: timestamp_evicted}
        self.eviction_history: Dict[str, float] = {}

        # Eviction policy weights
        self.weights = {
            "recency": 1.0,
            "frequency": 0.5,
            "predictive": 2.0,
            "thrash_penalty": 5.0 # High penalty prevents re-evicting highly thrashed items
        }

    def _calculate_eviction_score(self, item: CacheItemMetadata, current_time: float) -> float:
        """
        Calculates the retention score for an item. Lower score means higher chance of eviction.
        """
        # Time since last access (smaller is better for retention, so we inverse it)
        age = current_time - item.last_accessed
        recency_score = 1.0 / (age + 1.0) 
        
        # Frequency (cap to avoid overflow dominating)
        frequency_score = min(item.access_count, 100) / 100.0
        
        score = (
            (self.weights["recency"] * recency_score) +
            (self.weights["frequency"] * frequency_score) +
            (self.weights["predictive"] * item.predictive_weight) +
            (self.weights["thrash_penalty"] * item.thrash_count)
        )
        return score

    def _evict(self, size_needed: int = 1):
        """
        Evicts the lowest scoring items until size_needed is freed.
        """
        if self.current_size + size_needed <= self.max_capacity:
            return

        current_time = time.time()
        
        # Calculate scores for all items
        scored_items = []
        for key, meta in self.metadata.items():
            score = self._calculate_eviction_score(meta, current_time)
            scored_items.append((score, meta))

        # Sort by score ascending (lowest score evicted first)
        scored_items.sort(key=lambda x: x[0])

        bytes_freed = 0
        evicted_keys = []
        for score, meta in scored_items:
            if self.current_size - bytes_freed + size_needed <= self.max_capacity:
                break
                
            del self.cache[meta.key]
            del self.metadata[meta.key]
            
            # Record eviction for thrashing detection
            self.eviction_history[meta.key] = current_time
            
            bytes_freed += meta.size
            evicted_keys.append(meta.key)

        self.current_size -= bytes_freed
        log.debug(f"Evicted {len(evicted_keys)} items: {evicted_keys}. Freed size: {bytes_freed}")

    def put(self, key: str, value: Any, size: int = 1, predictive_weight: float = 1.0):
        """
        Adds or updates an item in the cache.
        """
        current_time = time.time()
        
        # Detect Thrashing: Was this recently evicted?
        is_thrashing = False
        if key in self.eviction_history:
            time_since_evict = current_time - self.eviction_history[key]
            if time_since_evict < self.thrash_window_sec:
                is_thrashing = True
                log.warning(f"Cache Thrashing Detected for key: {key} (Reloaded {time_since_evict:.1f}s after eviction)")
            # Remove from history since it's back in cache
            del self.eviction_history[key]

        if key in self.cache:
            # Update existing
            meta = self.metadata[key]
            self.current_size -= meta.size
            
            meta.size = size
            meta.access_count += 1
            meta.last_accessed = current_time
            meta.predictive_weight = max(meta.predictive_weight, predictive_weight) # Keep highest prediction
            if is_thrashing:
                meta.thrash_count += 1
                
            self._evict(size)
            self.cache[key] = value
            self.current_size += size
        else:
            # Insert new
            self._evict(size)
            meta = CacheItemMetadata(key, size)
            meta.predictive_weight = predictive_weight
            if is_thrashing:
                meta.thrash_count += 1
                
            self.cache[key] = value
            self.metadata[key] = meta
            self.current_size += size

    def get(self, key: str) -> Optional[Any]:
        """
        Retrieves an item and updates its metadata.
        """
        if key in self.cache:
            meta = self.metadata[key]
            meta.access_count += 1
            meta.last_accessed = time.time()
            # If hit, decay thrash count slightly to allow eventual eviction
            if meta.thrash_count > 0:
                meta.thrash_count = max(0, meta.thrash_count - 1)
            return self.cache[key]
        return None

    def update_predictive_weights(self, predictions: Dict[str, float]):
        """
        Layer 2 pushes new predictions here. 
        Updates the predictive weight of cached items matching the keys.
        """
        for key, weight in predictions.items():
            if key in self.metadata:
                self.metadata[key].predictive_weight = weight
                log.debug(f"Updated predictive weight for {key} to {weight}")
