# Mnemosyne

![Python](https://img.shields.io/badge/Python-111111?style=flat&logo=python&logoColor=3776AB)
![FastAPI](https://img.shields.io/badge/FastAPI-111111?style=flat&logo=fastapi&logoColor=009688)
![React](https://img.shields.io/badge/React-111111?style=flat&logo=react&logoColor=61DAFB)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-111111?style=flat&logo=tailwindcss&logoColor=38B2AC)
![LangGraph](https://img.shields.io/badge/LangGraph-111111?style=flat)
![Ollama](https://img.shields.io/badge/Ollama-111111?style=flat)
![PyTorch](https://img.shields.io/badge/PyTorch-111111?style=flat&logo=pytorch&logoColor=EE4C2C)
![ChromaDB](https://img.shields.io/badge/ChromaDB-111111?style=flat)
![SQLite](https://img.shields.io/badge/SQLite-111111?style=flat&logo=sqlite&logoColor=003B57)
![SQLAlchemy](https://img.shields.io/badge/SQLAlchemy-111111?style=flat)
![Zustand](https://img.shields.io/badge/Zustand-111111?style=flat)
![TanStack_Query](https://img.shields.io/badge/TanStack_Query-111111?style=flat&logo=tanstack&logoColor=FF4154)
![Docker](https://img.shields.io/badge/Docker-111111?style=flat&logo=docker&logoColor=2496ED)
![Docker_Compose](https://img.shields.io/badge/Docker_Compose-111111?style=flat&logo=docker&logoColor=2496ED)

## Overview

Mnemosyne is a context-aware, adaptive memory system designed for mobile agentic systems running on smartphones and edge devices. It combines operating system level memory optimization with persistent AI agent memory to improve responsiveness, stability, and continuity under constrained hardware conditions.

The platform treats memory as an intelligent adaptive layer rather than a fixed operating resource. By combining context monitoring, predictive intelligence, adaptive caching, and agent memory persistence, it enables on-device AI systems to remain performant while preserving task and user context across sessions.

## Problem

Modern mobile and edge devices are increasingly expected to support real-time AI inference, context-sensitive workflows, and multitasking across applications. These workloads frequently run into memory constraints that result in slower application launches, memory thrashing, inefficient cache behavior, and degraded system performance.

Traditional memory systems rely on static allocation and eviction strategies that do not account for user behavior, predicted next actions, or the state of an on-device agent. As a result, AI agents often lose continuity across app switches and session boundaries, and operating systems cannot proactively prepare for upcoming resource demands.

## Solution

Mnemosyne provides a unified architecture that connects adaptive memory allocation, next-context prediction, intelligent cache management, and persistent agent memory. The system is designed to optimize both operating efficiency and cognitive continuity for mobile AI agents.

This approach allows the platform to dynamically adjust memory strategy based on user activity and live device conditions. It also enables predictive pre-loading and structured long-term memory retention so that agents can respond with lower latency and better contextual awareness.

## Architecture

Mnemosyne follows a modular monolith architecture with strict internal module boundaries. It is deployed as a single FastAPI application while keeping services, interfaces, and data access isolated by module through a repository-driven design.

The architecture is centered on three cooperating layers supported by a shared resource-aware core.

### Adaptive Memory Manager

The adaptive memory manager serves as the operating system level foundation of the platform. It dynamically prioritizes processes based on current activity, workload importance, and anticipated future context instead of relying on static heuristics.

### Predictive Intelligence Engine

The predictive intelligence engine estimates the user’s next likely application or task using learned behavioral patterns. Its output informs pre-loading decisions and helps the memory manager allocate resources before demand becomes immediate.

### AI Agent Memory Layer

The AI agent memory layer preserves continuity for on-device agents through dedicated memory tiers for active state, past interactions, persistent knowledge, and ongoing tasks. This allows the system to maintain coherent behavior across sessions, app transitions, and memory pressure events.

## Features

| Capability | What It Does | Impact |
|---|---|---|
| Context-Aware Memory Allocation | Dynamically prioritizes memory based on user activity, workload type, and predicted next context. | Improves responsiveness under constrained memory conditions. |
| Predictive Pre-Loading | Predicts the next likely application or task and pre-loads relevant resources. | Reduces perceived latency and improves launch readiness. |
| Adaptive Caching | Uses a learned eviction strategy instead of static cache replacement rules. | Increases cache efficiency and reduces unnecessary eviction. |
| Persistent Agent Memory | Preserves working, episodic, semantic, and task memory for on-device agents. | Maintains continuity across sessions and app transitions. |
| Resource-Aware Adaptation | Adapts memory behavior using live battery, RAM, and connectivity signals. | Supports graceful degradation without breaking user experience. |
| Benchmarking and Evaluation | Measures system behavior under synthetic real-world workloads. | Validates performance, stability, and optimization gains. |
## System Design

Mnemosyne exposes multiple client surfaces through a common backend. These surfaces support observation, simulation, and context-aware interaction across environments.

- A simulation dashboard for visualizing live metrics and system behavior
- A command line daemon for observing terminal and system activity
- An editor extension surface for integrating memory-aware context into development workflows

## Technology Stack

| Layer | Technology |
|---|---|
| Prediction engine | PyTorch |
| Context monitoring | Python process monitor and ADB bridge |
| Memory allocation | Python simulation layer with learned policy |
| Cache manager | Custom Python adaptive eviction engine |
| Agent orchestration | LangGraph |
| Episodic memory store | ChromaDB |
| Structured memory store | SQLite with SQLAlchemy |
| Model serving | Ollama |
| Backend API | FastAPI |
| Frontend dashboard | React, Tailwind CSS, Zustand, TanStack Query |
| Benchmark suite | Python synthetic workload generator |
| Deployment | Docker and Docker Compose |

## Security and Engineering Standards

The project follows strict engineering controls to support maintainability and deployment safety. Configuration is managed through environment variables, request validation is enforced at the API boundary, database access is parameterized, and logging is structured for observability.

Additional safeguards include explicit cross-origin configuration, dependency pinning, protected environment files, and controlled error handling that avoids exposing internal failures to clients.

## Differentiation

Mnemosyne is designed to unify operating system level adaptive memory management with persistent AI agent memory in a single architecture. This makes it distinct from conventional memory optimizers, which generally focus only on allocation efficiency, and from agent frameworks, which generally do not manage underlying device memory behavior.

The result is a system built not only to improve performance but also to preserve context, continuity, and responsiveness for mobile agentic workloads.

## License

Licensed under the Apache 2.0 License.
