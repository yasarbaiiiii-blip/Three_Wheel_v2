# Rover UI Architecture & Coordinate System Context

*This document serves as a memory context file for future AI chats or developers working on `App.tsx` and the rover tracking logic.*

## 1. The Core Coordinate System (Frontend vs Backend)

A critical architectural detail to remember is how the backend handles the "Origin Check" (`auto_origin`):
* **The Backend does NOT reset telemetry:** When a mission is started with `auto_origin: true`, the backend does not zero out the physical telemetry coordinates. Instead, the backend mathematically **shifts the mission path** to match the rover's absolute global coordinates (e.g., `pos_n: 10000`, `pos_e: 10000`).
* **Telemetry is always absolute:** Throughout the mission, the `telemetrySnapshot.pos_n` and `pos_e` will constantly report these absolute global positions. 

## 2. The "Origin Check" (`autoOrigin`) UI State

Because the telemetry is always reporting absolute coordinates, the frontend UI must compensate to keep the visual plan and the rover icon aligned.
* When the user checks "Origin Check" (`autoOrigin`), the UI captures the rover's current telemetry and saves it to `originShift`. 
* The visual plan (`displayedLines`) is then dynamically shifted by this `originShift` so that it visually moves to `10000, 10000`.
* **CRITICAL RULE:** `autoOrigin` must **never** be automatically unchecked when a mission starts or finishes. If it is unchecked, `originShift` is cleared, the visual plan snaps back to `0,0`, and the map camera follows the plan. Because the telemetry continues to report `10000`, the rover icon will instantly "fly away" off the screen.

## 3. Rover Icon Rendering

The rover icon's position is rendered by the `<PlanPreview>` component.
* **Always use raw telemetry:** The rover icon must ALWAYS be rendered using the raw `telemetrySnapshot.pos_n` and `telemetrySnapshot.pos_e`.
* **No Freezing:** Previously, there was a state called `frozenRoverPos` that would forcefully overwrite the live telemetry with the coordinates of the last waypoint when the mission completed. This caused bugs where the camera (following the real rover) would drift away from the frozen icon if the rover overshot the endpoint or was driven manually. This logic was removed, and the UI should never attempt to fake or freeze the rover's position.

## Summary of Safe Behavior
- The rover icon strictly follows live telemetry.
- The visual plan is shifted by `originShift` (controlled by the "Origin Check" checkbox) to meet the rover.
- The UI map camera auto-fits to the visual plan.
