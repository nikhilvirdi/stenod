# Stenod

Stenod is a local, deterministic, out-of-band daemon that captures the causal history of a coding session (file changes, terminal outcomes, and optional AI-provider network traffic) and compiles it into an attention-structured Handoff Manifest. It does not share a failure domain with the AI it is recording, ensuring developers can seamlessly hand off and resume context across any AI tool when encountering rate limits, outages, or context-window exhaustion.

For full architectural, technological, and design details, see the [Single Source of Truth](singleSourceOfTruth.md).