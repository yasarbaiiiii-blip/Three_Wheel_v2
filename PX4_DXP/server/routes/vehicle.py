"""Vehicle control routes: arm, set_mode, estop. Auth-protected."""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException

from auth import require_token
from models import (
    ArmRequest,
    ArmResponse,
    EstopResponse,
    ManualControlRequest,
    ManualControlResponse,
    ModeRequest,
    ModeResponse,
)

router = APIRouter(tags=["vehicle"], dependencies=[Depends(require_token)])


def _now() -> str:
    return datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _record(level: str, message: str) -> None:
    from main import activity_log
    activity_log.append({"timestamp": _now(), "level": level, "message": message})


@router.post("/arm", response_model=ArmResponse)
async def arm_vehicle(req: ArmRequest):
    from main import ros_node
    if ros_node is None:
        raise HTTPException(503, "ROS node not ready")
    ok, why = await ros_node.arm_async(req.arm)
    verb = "Armed" if req.arm else "Disarmed"
    msg  = f"{verb} {'OK' if ok else f'FAILED: {why}'}"
    _record("info" if ok else "error", msg)
    return ArmResponse(success=ok, message=msg)


@router.post("/set_mode", response_model=ModeResponse)
async def set_mode(req: ModeRequest):
    from main import ros_node
    if ros_node is None:
        raise HTTPException(503, "ROS node not ready")
    ok, why = await ros_node.set_mode_async(req.mode.value)
    msg = f"Mode {req.mode.value} {'set' if ok else f'FAILED: {why}'}"
    _record("info" if ok else "error", msg)
    return ModeResponse(success=ok, message=msg)


@router.post("/manual_control", response_model=ManualControlResponse)
async def manual_control(req: ManualControlRequest):
    from main import ros_node
    if ros_node is None:
        raise HTTPException(503, "ROS node not ready")
    ok, why = ros_node.publish_manual_control(req.forward, req.yaw)
    if not ok:
        raise HTTPException(503, why or "Manual control unavailable")
    return ManualControlResponse(success=True, message="ok")


@router.post("/estop", response_model=EstopResponse)
async def emergency_stop():
    from main import emergency_handler
    if emergency_handler is None:
        raise HTTPException(503, "Emergency handler not ready")
    result = await emergency_handler.estop_async()
    return EstopResponse(**result)
