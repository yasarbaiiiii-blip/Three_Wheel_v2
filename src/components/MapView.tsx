import React, { useCallback, useEffect, useRef, useMemo, useState } from "react";
import { View, StyleSheet, ActivityIndicator, Text } from "react-native";
import { WebView } from "react-native-webview";

import type { TelemetrySnapshot, PlanLine } from "../types/plan";
import { transformVisualDxfPoint } from "../utils/visualAlignment";
import type { PlacedItem } from "./BoundaryEditor";

const EARTH_RADIUS = 6378137.0;

/**
 * Project local DXF meters (north/east relative to an origin) back to GPS lat/lon.
 */
function projectLocalMetersToGps(
  north: number,
  east: number,
  originLat: number,
  originLon: number
): { lat: number; lon: number } {
  const originLatRad = (originLat * Math.PI) / 180;
  const lat = originLat + (north / EARTH_RADIUS) * (180 / Math.PI);
  const lon =
    originLon + (east / (EARTH_RADIUS * Math.cos(originLatRad))) * (180 / Math.PI);
  return { lat, lon };
}

function projectGpsToLocalMeters(
  lat: number,
  lon: number,
  originLat: number,
  originLon: number
): { north: number; east: number } {
  const originLatRad = (originLat * Math.PI) / 180;
  const north = (lat - originLat) * (EARTH_RADIUS * Math.PI / 180);
  const east = (lon - originLon) * (EARTH_RADIUS * Math.cos(originLatRad) * Math.PI / 180);
  return { north, east };
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const l2 = (x1 - x2) ** 2 + (y1 - y2) ** 2;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function buildPlanLinesMsgKey(
  lines: PlanLine[],
  originLat: number,
  originLon: number
): string {
  if (lines.length === 0) return `0:${originLat}:${originLon}`;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const mid = lines[Math.floor(lines.length / 2)];
  return [
    lines.length,
    originLat,
    originLon,
    first.id,
    first.from.x.toFixed(2),
    first.from.y.toFixed(2),
    mid.from.x.toFixed(2),
    mid.from.y.toFixed(2),
    last.to.x.toFixed(2),
    last.to.y.toFixed(2),
  ].join(":");
}

export interface MapViewProps {
  telemetrySnapshot: TelemetrySnapshot | null;
  lines: PlanLine[];
  alignedRefPoints: { dxf_x: number; dxf_y: number; lat: number; lon: number }[];
  visible: boolean;
  recenterRoverTrigger?: number;
  recenterPlanTrigger?: number;
  onSelectPoint?: (pt: { x: number; y: number }) => void;
  onSelectLine?: (id: string | null) => void;
  selectedLineId?: string | null;
  showCornerPoints?: boolean;

  // Interactive templates mode support
  mode?: "fields" | "templates";
  placedItems?: PlacedItem[];
  selectedItemIds?: string[];
  lockPanDrag?: boolean;
  lockZoom?: boolean;
  boundaryWidth?: number;
  boundaryHeight?: number;
  indentSpacing?: number;
  sketchMode?: boolean;
  showRefPointLabels?: boolean;
  boundaryPosition?: { x: number; y: number };
  onMoveBoundary?: (x: number, y: number) => void;
  showBoundaryPoints?: boolean;
  activeSnapPointId?: string | null;
  onPlaceRoverAtPoint?: (pointId: string, localX: number, localY: number) => void;

  onUpdatePlacedItem?: (id: string, updates: Partial<PlacedItem>) => void;
  onUpdatePlacedItems?: (items: PlacedItem[]) => void;
  onSelectionChange?: (ids: string[]) => void;
  multiTouchMode?: "both" | "scale" | "rotate";
}

/**
 * Self-contained HTML string that boots Leaflet from CDN and listens for
 * postMessage commands from React Native.
 */
const LEAFLET_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    #map { width: 100%; height: 100%; }

    /* Premium reference point tooltip */
    .leaflet-tooltip.ref-tooltip {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid #10b981;
      color: #ffffff;
      font-size: 10px;
      font-weight: 700;
      border-radius: 4px;
      padding: 2px 6px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .leaflet-tooltip-right.ref-tooltip::before {
      border-right-color: rgba(15, 23, 42, 0.85);
    }

    .ref-marker {
      width: 14px; height: 14px;
      background: #10b981;
      border: 2.5px solid #ffffff;
      border-radius: 50%;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3);
    }

    /* Loading overlay */
    .loading-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(255,255,255,0.92);
      display: flex; align-items: center; justify-content: center;
      z-index: 10000; font-family: -apple-system, sans-serif;
      flex-direction: column; gap: 12px;
    }
    .loading-overlay .spinner {
      width: 36px; height: 36px;
      border: 3px solid #e2e8f0; border-top-color: #3b82f6;
      border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-overlay .label { color: #64748b; font-size: 13px; font-weight: 600; }

    /* Status badge */
    .status-badge {
      position: fixed; bottom: 12px; left: 12px; z-index: 9999;
      background: rgba(15,23,42,0.85); color: #e2e8f0;
      font-size: 11px; font-weight: 600; font-family: -apple-system, monospace;
      padding: 6px 12px; border-radius: 8px;
      backdrop-filter: blur(8px);
      pointer-events: none;
    }

    @keyframes pulse-circle {
      0% { opacity: 0.8; stroke-width: 0; }
      100% { opacity: 0; stroke-width: 15px; }
    }
    .pulsing-circle {
      animation: pulse-circle 1.5s infinite;
    }

    .boundary-drag-handle {
      width: 32px;
      height: 32px;
      margin-left: -16px;
      margin-top: -16px;
      pointer-events: none;
      filter: drop-shadow(0 1px 3px rgba(15, 23, 42, 0.35));
    }
    .boundary-drag-handle svg {
      display: block;
    }
  </style>
</head>
<body>
  <div id="loading" class="loading-overlay">
    <div class="spinner"></div>
    <div class="label">Loading Map…</div>
  </div>
  <div id="map"></div>
  <div id="status" class="status-badge">Waiting for data…</div>

  <script>
    // ── Leaflet Setup ──
    var osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 25,
      maxNativeZoom: 19,
      attribution: '© OpenStreetMap'
    });

    var satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 22,
      maxNativeZoom: 18,
      attribution: '© Esri'
    });

    var map = L.map('map', {
      center: [0, 0],
      zoom: 18,
      layers: [osm],
      zoomControl: true,
      attributionControl: false
    });

    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map);

    // Listen for map clicks and send back to React Native
    map.on('click', function(e) {
      if (mode !== 'templates') {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'mapClick',
            lat: e.latlng.lat,
            lon: e.latlng.lng
          }));
        }
      }
    });

    // Remove loading overlay after tiles load
    map.whenReady(function() {
      setTimeout(function() {
        var el = document.getElementById('loading');
        if (el) el.style.display = 'none';
      }, 600);
    });

    // ── State ──
    var mode = 'fields';
    var currentItems = [];
    var lockPanDrag = false;
    var lockZoom = false;
    var multiTouchMode = 'both';
    var sketchMode = false;

    var roverMarker = null;
    var roverCircle = null;
    var startArrowMarker = null;
    var planLinesGroup = L.layerGroup().addTo(map);
    var refPointsGroup = L.layerGroup().addTo(map);
    var itemLayersGroup = L.layerGroup().addTo(map);
    var boundaryLayersGroup = L.layerGroup().addTo(map);
    var boundaryPointsGroup = L.layerGroup().addTo(map);
    var selectedLineLayer = null;
    var cornerMarkers = L.layerGroup().addTo(map);
    
    var nextTargetLine = null;
    var nextTargetCircle = null;
    var currentRefPoints = [];
    var activeRefPointMarker = null;
    var refPointLabelsVisible = false;

    var boundaryControlPointsData = [];
    var boundaryDragHandleLatLng = null;
    var showBoundaryPoints = false;
    var activeSnapPointId = null;
    var snapGlowCircle = L.circleMarker([0,0], {
      radius: 12,
      color: '#eab308',
      fillColor: '#eab308',
      fillOpacity: 0.4,
      weight: 2,
      className: 'pulsing-circle'
    });

    var hasAutocentered = false;
    var statusEl = document.getElementById('status');

    function updateStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }

    function postMessage(msg) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    }

    // ── Boundary drag tuning ──
    var BOUNDARY_HANDLE_HIT_PX = 44;
    var MIN_BOUNDARY_DRAG_PX = 5;

    // ── Boundary drag debug (set false to silence) ──
    var boundaryDragDebugEnabled = false;
    var lastBoundaryDebugMoveLog = 0;

    function debugBoundary(stage, payload) {
      if (!boundaryDragDebugEnabled) return;
      var entry = {
        type: 'boundaryDragDebug',
        stage: stage,
        ts: Date.now(),
        payload: payload || {}
      };
      console.log('[BoundaryDrag]', stage, entry.payload);
      postMessage(entry);
    }

    // Helper: Distance from point to line segment
    function distToSegment(p, p1, p2) {
      var x = p.x, y = p.y;
      var x1 = p1.x, y1 = p1.y;
      var x2 = p2.x, y2 = p2.y;
      var l2 = (x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2);
      if (l2 === 0) return Math.hypot(x - x1, y - y1);
      var t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / l2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)));
    }

    function pointInPolygon(point, polygon) {
      var inside = false;
      for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        var xi = polygon[i].x, yi = polygon[i].y;
        var xj = polygon[j].x, yj = polygon[j].y;
        var intersect = ((yi > point.y) !== (yj > point.y)) &&
          (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }

    // ── Rover Marker ──
    function updateRover(lat, lon, heading, nextTarget) {
      if (lat == null || lon == null) return;

      var latlng = [lat, lon];

      if (!roverMarker) {
        var headingAngle = heading != null ? heading : 0;
        var icon = L.divIcon({
          className: 'rover-marker-wrapper',
          html: '<div id="rover-vehicle" style="transform: rotate(' + headingAngle + 'deg); transition: transform 0.2s ease; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;">' +
                '<svg width="40" height="40" viewBox="-20 -20 40 40" style="display: block;">' +
                '<circle cx="0" cy="0" r="18.7" fill="rgba(14,165,233,0.12)" />' +
                '<polygon points="-6.5,11 6.5,11 6.5,-4 0,-7.5 -6.5,-4" fill="#0ea5e9" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round" />' +
                '<polygon points="-9.5,5 -6.5,5 -6.5,11 -9.5,11" fill="#0f172a" />' +
                '<polygon points="9.5,5 6.5,5 6.5,11 9.5,11" fill="#0f172a" />' +
                '<polygon points="-2.5,3 2.5,3 2.5,-3 -2.5,-3" fill="#0f172a" />' +
                '<polygon points="-4.5,-2 4.5,-2 3.5,2 -3.5,2" fill="rgba(186,230,253,0.85)" />' +
                '<circle cx="0" cy="-7.5" r="2.5" fill="#fbbf24" stroke="#fff" stroke-width="1" />' +
                '</svg>' +
                '</div>',
          iconSize: [40, 40],
          iconAnchor: [20, 20]
        });
        roverMarker = L.marker(latlng, { icon: icon, zIndexOffset: 1000 }).addTo(map);

        roverCircle = L.circle(latlng, {
          radius: 1.5,
          color: '#3b82f6',
          fillColor: '#3b82f6',
          fillOpacity: 0.12,
          weight: 1.5,
          dashArray: '4 4'
        }).addTo(map);
      } else {
        roverMarker.setLatLng(latlng);
        roverCircle.setLatLng(latlng);
      }

      // Rotate vehicle
      var el = document.getElementById('rover-vehicle');
      if (el && heading != null) {
        el.style.transform = 'rotate(' + heading + 'deg)';
      }

      if (nextTarget) {
        var tl = L.latLng(nextTarget.lat, nextTarget.lon);
        if (!nextTargetLine) {
          nextTargetLine = L.polyline([latlng, tl], {
            color: '#f59e0b',
            weight: 2,
            dashArray: '4 4'
          }).addTo(map);
          nextTargetCircle = L.circleMarker(tl, {
            radius: 5,
            color: '#f59e0b',
            fillColor: '#f59e0b',
            fillOpacity: 0.5,
            className: 'pulsing-circle'
          }).addTo(map);
        } else {
          nextTargetLine.setLatLngs([latlng, tl]);
          nextTargetCircle.setLatLng(tl);
        }
      } else {
        if (nextTargetLine) {
          map.removeLayer(nextTargetLine);
          map.removeLayer(nextTargetCircle);
          nextTargetLine = null;
          nextTargetCircle = null;
        }
      }

      if (!hasAutocentered) {
        map.setView(latlng, 19, { animate: false });
        hasAutocentered = true;
      }
      updateStatus('Rover: ' + lat.toFixed(6) + ', ' + lon.toFixed(6));
    }

    // ── Plan Lines ──
    function updatePlanLines(linesData) {
      planLinesGroup.clearLayers();
      if (startArrowMarker) {
        map.removeLayer(startArrowMarker);
        startArrowMarker = null;
      }

      if (!linesData || linesData.length === 0) return;

      var allLatLngs = [];

      for (var i = 0; i < linesData.length; i++) {
        var seg = linesData[i];
        var coords = seg.coords;
        var color = seg.color || '#0f172a';
        var weight = seg.weight || 2;

        if (coords && coords.length >= 2) {
          var polyline = L.polyline(coords, {
            color: color,
            weight: weight,
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round'
          });
          planLinesGroup.addLayer(polyline);

          for (var j = 0; j < coords.length; j++) {
            allLatLngs.push(coords[j]);
          }
        }
      }

      // Add Start Direction Arrow at the start of the first segment of the plan
      if (linesData[0] && linesData[0].coords && linesData[0].coords.length >= 2) {
        var p1 = linesData[0].coords[0];
        var p2 = linesData[0].coords[1];
        
        // dy = Lat, dx = Lon adjusted for latitude
        var dy = p2[0] - p1[0];
        var dx = (p2[1] - p1[1]) * Math.cos(p1[0] * Math.PI / 180);
        var angle = Math.atan2(dx, dy) * 180 / Math.PI; // degrees clockwise from North
        
        var arrowHtml = '<div style="transform: rotate(' + angle + 'deg); width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 14px solid #ef4444; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));"></div>';
        
        var arrowIcon = L.divIcon({
          className: '',
          html: arrowHtml,
          iconSize: [12, 14],
          iconAnchor: [6, 7]
        });
        
        startArrowMarker = L.marker(p1, { icon: arrowIcon }).addTo(map);
      }

      // If no rover, fit to plan bounds
      if (!hasAutocentered && allLatLngs.length > 0) {
        var bounds = L.latLngBounds(allLatLngs);
        map.fitBounds(bounds, { padding: [40, 40] });
        hasAutocentered = true;
      }
    }

    // ── Reference Points ──
    function updateRefPoints(points) {
      refPointsGroup.clearLayers();
      currentRefPoints = points || [];
      activeRefPointMarker = null;

      if (!points || points.length === 0) return;

      for (var i = 0; i < points.length; i++) {
        var pt = points[i];
        var icon = L.divIcon({
          className: '',
          html: '<div class="ref-marker"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });
        (function(markerIndex) {
          var marker = L.marker([pt.lat, pt.lon], { icon: icon }).addTo(refPointsGroup);
          marker._refPointIndex = markerIndex;
          marker.bindTooltip('Ref #' + (markerIndex + 1) + ' (' + pt.lat.toFixed(6) + ', ' + pt.lon.toFixed(6) + ')', {
            permanent: false,
            direction: 'right',
            className: 'ref-tooltip',
            offset: [10, 0]
          });
          marker.on('click', function() {
            if (!refPointLabelsVisible) return;
            if (activeRefPointMarker && activeRefPointMarker !== marker) {
              activeRefPointMarker.closeTooltip();
            }
            if (activeRefPointMarker === marker && marker.isTooltipOpen && marker.isTooltipOpen()) {
              marker.closeTooltip();
              activeRefPointMarker = null;
              return;
            }
            marker.openTooltip();
            activeRefPointMarker = marker;
          });
        })(i);
      }
    }

    // ── Render Placed Items (Templates Mode) ──
    function renderPlacedItems(items) {
      itemLayersGroup.clearLayers();
      currentItems = items;

      items.forEach(function(item) {
        // Draw template lines
        item.lines.forEach(function(line) {
          var poly = L.polyline([
            [line.from.lat, line.from.lon],
            [line.to.lat, line.to.lon]
          ], {
            color: '#16a34a',
            weight: 2,
            opacity: sketchMode && !item.selected ? 0.2 : (item.selected ? 1.0 : 0.8),
            lineCap: 'round',
            lineJoin: 'round',
            interactive: false
          });
          poly._itemId = item.id;
          itemLayersGroup.addLayer(poly);
        });

        // Draw bounding box polygon
        if (item.box && item.box.length >= 4) {
          var boxPoly = L.polygon(item.box, {
            color: item.selected ? '#ef4444' : '#3b82f6',
            weight: 1.5,
            fillColor: item.selected ? '#ef4444' : '#3b82f6',
            fillOpacity: item.selected ? 0.05 : 0.02,
            dashArray: item.selected ? '' : '4 4',
            interactive: false
          });
          boxPoly._itemId = item.id;
          itemLayersGroup.addLayer(boxPoly);
        }
      });
    }

    // ── Render Boundary Box (Templates Mode) ──
    function renderBoundary(boundary, controlPoints, isSelected) {
      boundaryLayersGroup.clearLayers();
      if (!boundary || !boundary.outer || boundary.outer.length < 4) return;

      var outerPoly = L.polyline(boundary.outer, {
        color: isSelected ? '#ef4444' : '#0f172a',
        weight: isSelected ? 4 : 2,
        opacity: 0.9,
      });
      outerPoly._boundaryId = 'boundary';
      boundaryLayersGroup.addLayer(outerPoly);

      if (boundary.indent && boundary.indent.length > 0) {
        var indentPoly = L.polyline(boundary.indent, {
          color: '#cbd5e1',
          weight: 2,
          dashArray: '5, 5',
          interactive: false
        });
        boundaryLayersGroup.addLayer(indentPoly);
      }

      if (isSelected && boundary.outer.length >= 4) {
        var tl = boundary.outer[0];
        var handleLatLng = L.latLng(tl[0], tl[1]);
        boundaryDragHandleLatLng = handleLatLng;
        debugBoundary('renderBoundary_handle', {
          isSelected: true,
          handleLat: handleLatLng.lat,
          handleLng: handleLatLng.lng,
          interactive: false
        });

        var handleIcon = L.divIcon({
          className: '',
          html: '<div class="boundary-drag-handle">' +
            '<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">' +
            '<circle cx="16" cy="16" r="14" fill="#3b82f6" stroke="#ffffff" stroke-width="2"/>' +
            '<path d="M16 8v16M8 16h16" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>' +
            '<path d="M16 8l-2.5 3.5M16 8l2.5 3.5M24 16l-3.5 2.5M24 16l-3.5-2.5M16 24l2.5-3.5M16 24l-2.5-3.5M8 16l3.5-2.5M8 16l3.5 2.5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg></div>',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        var handleMarker = L.marker(handleLatLng, {
          icon: handleIcon,
          interactive: false,
          zIndexOffset: 1000,
        });
        handleMarker._isDragHandle = true;
        boundaryLayersGroup.addLayer(handleMarker);
      } else {
        boundaryDragHandleLatLng = null;
      }

      syncTemplatesMapDragging();
      renderBoundaryControlPoints(controlPoints);
    }

    function renderBoundaryControlPoints(controlPoints, activePointId) {
      boundaryPointsGroup.clearLayers();
      if (!controlPoints || controlPoints.length === 0) return;

      controlPoints.forEach(function(cp) {
        var isActive = activePointId && cp.id === activePointId;

        if (isActive) {
          boundaryPointsGroup.addLayer(L.circleMarker(cp.latlng, {
            radius: 13,
            color: '#f59e0b',
            fillColor: 'transparent',
            fillOpacity: 0,
            weight: 3,
            opacity: 0.55,
            interactive: false,
          }));
          boundaryPointsGroup.addLayer(L.circleMarker(cp.latlng, {
            radius: 9,
            color: '#f59e0b',
            fillColor: '#f59e0b',
            fillOpacity: 0.18,
            weight: 2,
            opacity: 0.65,
            className: 'pulsing-circle',
            interactive: false,
          }));
        }

        boundaryPointsGroup.addLayer(L.circleMarker(cp.latlng, {
          radius: isActive ? 7 : 5,
          color: isActive ? '#f59e0b' : '#3b82f6',
          fillColor: isActive ? '#f59e0b' : '#3b82f6',
          fillOpacity: isActive ? 0.9 : 0.6,
          weight: 2,
          interactive: false, // Don't block clicks on boundary edges
        }));
      });
    }

    // ── Update Selection Highlights (Fields Mode) ──
    function updateSelection(data) {
      if (selectedLineLayer) {
        map.removeLayer(selectedLineLayer);
        selectedLineLayer = null;
      }
      cornerMarkers.clearLayers();

      if (!data) return;

      if (data.line && data.line.coords && data.line.coords.length >= 2) {
        selectedLineLayer = L.polyline(data.line.coords, {
          color: '#ef4444',
          weight: 4,
          opacity: 1,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(map);
      }

      if (data.cornerPoints && data.cornerPoints.length > 0) {
        data.cornerPoints.forEach(function(pt) {
          L.circleMarker([pt.lat, pt.lon], {
            radius: 5,
            color: '#3b82f6',
            fillColor: '#3b82f6',
            fillOpacity: 0.9,
            weight: 2
          }).addTo(cornerMarkers);
        });
      }
    }

    function clearSelection() {
      if (selectedLineLayer) {
        map.removeLayer(selectedLineLayer);
        selectedLineLayer = null;
      }
      cornerMarkers.clearLayers();
    }

    // ── Hit Testing ──
    function hitTest(latlng) {
      var minDistance = Infinity;
      var hitId = null;
      var thresholdPx = 18; // pixels

      var clickPoint = map.latLngToContainerPoint(latlng);

      currentItems.forEach(function(item) {
        // Test lines
        item.lines.forEach(function(line) {
          var p1 = map.latLngToContainerPoint([line.from.lat, line.from.lon]);
          var p2 = map.latLngToContainerPoint([line.to.lat, line.to.lon]);
          var d = distToSegment(clickPoint, p1, p2);
          if (d < minDistance) {
            minDistance = d;
            hitId = item.id;
          }
        });

        // Test bounding box edges and interior
        if (item.box && item.box.length >= 4) {
          for (var i = 0; i < item.box.length; i++) {
            var nextIdx = (i + 1) % item.box.length;
            var p1 = map.latLngToContainerPoint(item.box[i]);
            var p2 = map.latLngToContainerPoint(item.box[nextIdx]);
            var d = distToSegment(clickPoint, p1, p2);
            if (d < minDistance) {
              minDistance = d;
              hitId = item.id;
            }
          }
          var boxPts = item.box.map(function(corner) {
            return map.latLngToContainerPoint(corner);
          });
          if (pointInPolygon(clickPoint, boxPts)) {
            minDistance = 0;
            hitId = item.id;
          }
        }
      });

      // Drag handle (high priority — right after item geometry)
      var handleDistPx = null;
      if (boundaryDragHandleLatLng) {
        var handlePt = map.latLngToContainerPoint(boundaryDragHandleLatLng);
        handleDistPx = Math.hypot(clickPoint.x - handlePt.x, clickPoint.y - handlePt.y);
        if (handleDistPx <= BOUNDARY_HANDLE_HIT_PX) {
          debugBoundary('hitTest', {
            result: 'boundary-drag-handle',
            handleDistPx: handleDistPx,
            handleThresholdPx: BOUNDARY_HANDLE_HIT_PX,
            minDistancePx: minDistance,
            hasHandleLatLng: true
          });
          return 'boundary-drag-handle';
        }
      }

      // Hit test boundary (always — independent of showBoundaryPoints visibility)
      var boundaryLayers = boundaryLayersGroup.getLayers();
      if (boundaryLayers.length > 0) {
        var outerPoly = boundaryLayers[0];
        if (outerPoly && outerPoly.getLatLngs) {
          var lls = outerPoly.getLatLngs();
          if (lls && lls.length > 0) {
            var flatLls = Array.isArray(lls[0]) ? lls[0] : lls;

            // Test boundary edges (enables edge drag via onMouseDown)
            for (var bi = 0; bi < flatLls.length - 1; bi++) {
              var bp1 = map.latLngToContainerPoint(flatLls[bi]);
              var bp2 = map.latLngToContainerPoint(flatLls[bi + 1]);
              var bd = distToSegment(clickPoint, bp1, bp2);
              if (bd < minDistance) {
                minDistance = bd;
                hitId = 'boundary-interior';
              }
            }

            // Test boundary interior when tap is not closer to an item edge/line
            var bounds = outerPoly.getBounds();
            if (bounds.contains(latlng) && minDistance > thresholdPx) {
              hitId = 'boundary-interior';
              minDistance = 0;
            }
          }
        }
      }

      if (minDistance <= thresholdPx) {
        if (hitId === 'boundary-interior' || hitId === 'boundary-drag-handle') {
          debugBoundary('hitTest', {
            result: hitId,
            handleDistPx: handleDistPx,
            minDistancePx: minDistance,
            thresholdPx: thresholdPx,
            hasHandleLatLng: !!boundaryDragHandleLatLng
          });
        }
        return hitId;
      }

      debugBoundary('hitTest', {
        result: null,
        handleDistPx: handleDistPx,
        minDistancePx: minDistance,
        thresholdPx: thresholdPx,
        lastHitId: hitId,
        hasHandleLatLng: !!boundaryDragHandleLatLng
      });
      return null;
    }

    // ── Dragging & Multi-Touch Gestures ──
    var activeDrag = null; // { type: 'items'|'background', ids: [], startLatlng: L.LatLng, itemsStart: [] }
    var touchState = null; // { initialDist, initialAngle, itemsStart, lastScale, lastRotation }

    function isPlacedItemHitId(hitId) {
      return !!(hitId && currentItems.some(function(it) { return it.id === hitId; }));
    }

    function syncTemplatesMapDragging() {
      if (mode !== 'templates') return;
      if (
        lockPanDrag ||
        boundaryDragHandleLatLng ||
        (activeDrag && (activeDrag.type === 'boundary' || activeDrag.type === 'items'))
      ) {
        map.dragging.disable();
      } else if (!activeDrag || activeDrag.type === 'background') {
        map.dragging.enable();
      }
    }

    function finishBoundaryDrag(endLatlng) {
      if (!activeDrag || activeDrag.type !== 'boundary') return;

      var latDelta = activeDrag.currentLatDelta !== undefined
        ? activeDrag.currentLatDelta
        : (endLatlng.lat - activeDrag.startLatlng.lat);
      var lonDelta = activeDrag.currentLonDelta !== undefined
        ? activeDrag.currentLonDelta
        : (endLatlng.lng - activeDrag.startLatlng.lng);

      if (map.hasLayer(snapGlowCircle)) {
        map.removeLayer(snapGlowCircle);
      }

      var p1 = map.latLngToContainerPoint(activeDrag.startLatlng);
      var p2 = map.latLngToContainerPoint(endLatlng);
      var pxDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);

      debugBoundary('onMouseUp_boundary', {
        latDelta: latDelta,
        lonDelta: lonDelta,
        pxDist: pxDist,
        committed: pxDist >= MIN_BOUNDARY_DRAG_PX,
        hadCurrentDelta: activeDrag.currentLatDelta !== undefined
      });

      if (pxDist >= MIN_BOUNDARY_DRAG_PX) {
        postMessage({ type: 'boundaryDragged', latDelta: latDelta, lonDelta: lonDelta });
      }

      debugBoundary('onMouseUp', {
        endedDragType: 'boundary',
        lockPanDrag: lockPanDrag
      });
      activeDrag = null;
      syncTemplatesMapDragging();
    }

    function startBoundaryDrag(latlng, sourceHitId) {
      postMessage({ type: 'selectItems', ids: ['boundary'] });
      if (lockPanDrag) {
        debugBoundary('startBoundaryDrag_blocked', {
          reason: 'lockPanDrag',
          hitId: sourceHitId,
          lat: latlng.lat,
          lng: latlng.lng
        });
        return;
      }
      activeDrag = {
        type: 'boundary',
        startLatlng: latlng
      };
      var layerCount = 0;
      var handleSnapshotted = false;
      boundaryLayersGroup.eachLayer(function(layer) {
        if (layer.getLatLngs) {
          layer._dragStartLatLngs = JSON.parse(JSON.stringify(layer.getLatLngs()));
          layerCount++;
        } else if (layer._isDragHandle && layer.getLatLng) {
          layer._dragStartLatLng = layer.getLatLng();
          handleSnapshotted = true;
        }
      });
      map.dragging.disable();
      map.touchZoom.disable();
      syncTemplatesMapDragging();
      debugBoundary('startBoundaryDrag', {
        hitId: sourceHitId,
        lat: latlng.lat,
        lng: latlng.lng,
        lockPanDrag: lockPanDrag,
        mapDraggingEnabled: map.dragging && map.dragging.enabled(),
        boundaryLayersSnapshotted: layerCount,
        handleSnapshotted: handleSnapshotted,
        handleLatLng: boundaryDragHandleLatLng ? [boundaryDragHandleLatLng.lat, boundaryDragHandleLatLng.lng] : null
      });
    }

    function startItemDrag(latlng, hitId) {
      var selectedIds = currentItems.filter(function(it) { return it.selected; }).map(function(it) { return it.id; });
      if (!selectedIds.includes(hitId)) {
        selectedIds = [hitId];
        postMessage({ type: 'selectItems', ids: selectedIds });
      }

      if (lockPanDrag) return;

      var starts = selectedIds.map(function(id) {
        var item = currentItems.find(function(it) { return it.id === id; });
        return { id: id, x: item.x, y: item.y, rotation: item.rotation, scale: item.scale };
      });

      activeDrag = {
        type: 'items',
        ids: selectedIds,
        startLatlng: latlng,
        itemsStart: starts
      };

      itemLayersGroup.eachLayer(function(layer) {
        if (selectedIds.includes(layer._itemId) && layer.getLatLngs) {
          layer._dragStartLatLngs = JSON.parse(JSON.stringify(layer.getLatLngs()));
        }
      });

      map.dragging.disable();
      map.touchZoom.disable();
      syncTemplatesMapDragging();
    }

    function onMouseDown(e) {
      if (mode !== 'templates') return;

      var hitId = hitTest(e.latlng);
      debugBoundary('onMouseDown', {
        hitId: hitId,
        lat: e.latlng.lat,
        lng: e.latlng.lng,
        lockPanDrag: lockPanDrag,
        mapDraggingEnabled: map.dragging && map.dragging.enabled(),
        activeDragBefore: activeDrag ? activeDrag.type : null
      });

      if (hitId) {
        if (hitId === 'boundary-interior' || hitId === 'boundary-drag-handle') {
          startBoundaryDrag(e.latlng, hitId);
          return;
        }

        if (isPlacedItemHitId(hitId)) {
          startItemDrag(e.latlng, hitId);
          return;
        }
      } else {
        activeDrag = {
          type: 'background',
          startLatlng: e.latlng
        };
        if (!lockPanDrag) {
          map.dragging.enable();
        }
        debugBoundary('onMouseDown_background', {
          lat: e.latlng.lat,
          lng: e.latlng.lng,
          note: 'No hitTest match — map may pan on move'
        });
      }
    }

    function onMouseMove(e) {
      if (!activeDrag) {
        return;
      }
      if (lockPanDrag) {
        debugBoundary('onMouseMove_blocked', {
          reason: 'lockPanDrag',
          activeDragType: activeDrag.type
        });
        return;
      }

      if (activeDrag.type === 'items') {
        var latDelta = e.latlng.lat - activeDrag.startLatlng.lat;
        var lonDelta = e.latlng.lng - activeDrag.startLatlng.lng;

        // Move layers locally in Leaflet at 60fps
        itemLayersGroup.eachLayer(function(layer) {
          if (activeDrag.ids.includes(layer._itemId) && layer._dragStartLatLngs) {
             var lls = layer._dragStartLatLngs;
             if (Array.isArray(lls[0])) {
                var newLls = lls[0].map(function(ll) {
                   return L.latLng(ll.lat + latDelta, ll.lng + lonDelta);
                });
                layer.setLatLngs([newLls]);
             } else {
                var newLls = lls.map(function(ll) {
                   return L.latLng(ll.lat + latDelta, ll.lng + lonDelta);
                });
                layer.setLatLngs(newLls);
             }
          }
        });
      } else if (activeDrag.type === 'boundary') {
        var latDelta = e.latlng.lat - activeDrag.startLatlng.lat;
        var lonDelta = e.latlng.lng - activeDrag.startLatlng.lng;

        var snapped = false;
        var rll = null;
        if (roverMarker && boundaryControlPointsData && boundaryControlPointsData.length > 0) {
          rll = roverMarker.getLatLng();
          var bestDist = Infinity;
          var bestPtIdx = -1;

          for (var i = 0; i < boundaryControlPointsData.length; i++) {
            var cp = boundaryControlPointsData[i];
            var pLat = cp.latlng[0] + latDelta;
            var pLng = cp.latlng[1] + lonDelta;
            
            var dist = map.distance([pLat, pLng], rll);
            if (dist < 3.0 && dist < bestDist) { // Snap threshold: 3 meters
              bestDist = dist;
              bestPtIdx = i;
            }
          }

          if (bestPtIdx !== -1) {
            var cp = boundaryControlPointsData[bestPtIdx];
            latDelta = rll.lat - cp.latlng[0];
            lonDelta = rll.lng - cp.latlng[1];
            snapped = true;
          }
        }

        if (snapped && rll) {
           if (!map.hasLayer(snapGlowCircle)) {
             snapGlowCircle.addTo(map);
           }
           snapGlowCircle.setLatLng(rll);
        } else {
           if (map.hasLayer(snapGlowCircle)) {
             map.removeLayer(snapGlowCircle);
           }
        }

        activeDrag.currentLatDelta = latDelta;
        activeDrag.currentLonDelta = lonDelta;

        var now = Date.now();
        if (now - lastBoundaryDebugMoveLog > 250) {
          lastBoundaryDebugMoveLog = now;
          debugBoundary('onMouseMove_boundary', {
            latDelta: latDelta,
            lonDelta: lonDelta,
            snapped: snapped,
            mapDraggingEnabled: map.dragging && map.dragging.enabled()
          });
        }

        boundaryLayersGroup.eachLayer(function(layer) {
          if (layer._dragStartLatLngs) {
             var lls = layer._dragStartLatLngs;
             if (Array.isArray(lls[0])) {
                var newLls = lls[0].map(function(ll) {
                   return L.latLng(ll.lat + latDelta, ll.lng + lonDelta);
                });
                layer.setLatLngs([newLls]);
             } else {
                var newLls = lls.map(function(ll) {
                   return L.latLng(ll.lat + latDelta, ll.lng + lonDelta);
                });
                layer.setLatLngs(newLls);
             }
          } else if (layer._isDragHandle && layer._dragStartLatLng) {
             layer.setLatLng(L.latLng(
               layer._dragStartLatLng.lat + latDelta,
               layer._dragStartLatLng.lng + lonDelta
             ));
          }
        });
        
        boundaryPointsGroup.eachLayer(function(layer) {
          if (layer._originalLatLng) {
            layer.setLatLng(L.latLng(layer._originalLatLng[0] + latDelta, layer._originalLatLng[1] + lonDelta));
          }
        });
      }
    }

    function onMouseUp(e) {
      if (!activeDrag) return;

      if (activeDrag.type === 'items') {
        var p1 = map.latLngToContainerPoint(activeDrag.startLatlng);
        var p2 = map.latLngToContainerPoint(e.latlng);
        var dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);

        // Only trigger move updates if the item was physically dragged (not a tap).
        if (dist >= MIN_BOUNDARY_DRAG_PX) {
          var latDelta = e.latlng.lat - activeDrag.startLatlng.lat;
          var lonDelta = e.latlng.lng - activeDrag.startLatlng.lng;

          var originLatRad = (activeDrag.startLatlng.lat * Math.PI) / 180;
          var dy = latDelta * (6378137.0 * Math.PI / 180);
          var dx = lonDelta * (6378137.0 * Math.cos(originLatRad) * Math.PI / 180);

          var updates = activeDrag.itemsStart.map(function(start) {
            return {
              id: start.id,
              x: start.x + dx,
              y: start.y + dy
            };
          });

          postMessage({ type: 'itemsMoved', updates: updates });
        }
      } else if (activeDrag.type === 'background') {
        var p1 = map.latLngToContainerPoint(e.latlng);
        var p2 = map.latLngToContainerPoint(activeDrag.startLatlng);
        var dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (dist < 5) {
          if (activeDrag.type === 'boundary') {
            // Keep boundary selected if they just clicked it
          } else {
            postMessage({ type: 'selectItems', ids: [] });
          }
        }
      } else if (activeDrag.type === 'boundary') {
        finishBoundaryDrag(e.latlng);
        return;
      }

      debugBoundary('onMouseUp', {
        endedDragType: activeDrag ? activeDrag.type : null,
        lockPanDrag: lockPanDrag
      });
      activeDrag = null;
      syncTemplatesMapDragging();
      if (!lockPanDrag) {
        map.touchZoom.enable();
      }
    }

    // Touch handlers (capture phase on container — runs before Leaflet pan)
    function onContainerTouchStart(e) {
      if (mode !== 'templates') return;
      var touches = e.touches;
      if (!touches || touches.length !== 1) return;

      var latlng = map.mouseEventToLatLng(touches[0]);
      var hitId = hitTest(latlng);

      if (hitId === 'boundary-interior' || hitId === 'boundary-drag-handle') {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        debugBoundary('onContainerTouchStart', {
          hitId: hitId,
          lat: latlng.lat,
          lng: latlng.lng
        });
        startBoundaryDrag(latlng, hitId);
      } else if (isPlacedItemHitId(hitId)) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        startItemDrag(latlng, hitId);
      }
    }

    function onContainerTouchMove(e) {
      if (mode !== 'templates') return;
      if (!activeDrag) return;
      var touches = e.touches;
      if (!touches || touches.length !== 1) return;

      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      onMouseMove({ latlng: map.mouseEventToLatLng(touches[0]) });
    }

    function onContainerTouchEnd(e) {
      if (mode !== 'templates') return;
      if (!activeDrag) return;
      var touch = e.changedTouches && e.changedTouches[0];
      if (!touch) return;

      if (e.cancelable) e.preventDefault();
      e.stopPropagation();

      if (activeDrag.type === 'boundary') {
        finishBoundaryDrag(map.mouseEventToLatLng(touch));
      } else {
        onMouseUp({ latlng: map.mouseEventToLatLng(touch) });
      }
    }

    function onTouchStart(e) {
      if (mode !== 'templates') return;

      var touches = e.touches || e.originalEvent.touches;
      debugBoundary('onTouchStart', {
        touchCount: touches.length,
        mapDraggingEnabled: map.dragging && map.dragging.enabled(),
        activeDragBefore: activeDrag ? activeDrag.type : null
      });

      if (touches.length === 1) {
        if (activeDrag && (activeDrag.type === 'boundary' || activeDrag.type === 'items')) return;
        var latlng = map.mouseEventToLatLng(touches[0]);
        onMouseDown({ latlng: latlng });
        debugBoundary('onTouchStart_afterMouseDown', {
          activeDragAfter: activeDrag ? activeDrag.type : null,
          mapDraggingEnabled: map.dragging && map.dragging.enabled()
        });
      } else if (touches.length === 2 && !lockPanDrag) {
        var p1 = map.mouseEventToContainerPoint(touches[0]);
        var p2 = map.mouseEventToContainerPoint(touches[1]);
        var dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        var angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

        var selectedIds = currentItems.filter(function(it) { return it.selected; }).map(function(it) { return it.id; });
        if (selectedIds.length > 0) {
          var starts = selectedIds.map(function(id) {
            var item = currentItems.find(function(it) { return it.id === id; });
            return { id: id, x: item.x, y: item.y, rotation: item.rotation, scale: item.scale };
          });

          touchState = {
            initialDist: dist,
            initialAngle: angle,
            itemsStart: starts,
            lastScale: 1.0,
            lastRotation: 0.0
          };

          itemLayersGroup.eachLayer(function(layer) {
            if (selectedIds.includes(layer._itemId) && layer.getLatLngs) {
              layer._pinchStartLatLngs = JSON.parse(JSON.stringify(layer.getLatLngs()));
            }
          });

          map.dragging.disable();
          map.touchZoom.disable();
        }
      }
    }

    function updatePinchVisuals(scaleMult, angleDelta) {
      var cos = Math.cos(angleDelta * Math.PI / 180);
      var sin = Math.sin(angleDelta * Math.PI / 180);

      itemLayersGroup.eachLayer(function(layer) {
        if (touchState.itemsStart.some(function(it) { return it.id === layer._itemId; })) {
          var item = currentItems.find(function(it) { return it.id === layer._itemId; });
          var center = item.center;

          if (layer._pinchStartLatLngs) {
            var lls = layer._pinchStartLatLngs;
            var rotatePoint = function(ll) {
              var latOffset = ll.lat - center.lat;
              var lonOffset = ll.lng - center.lon;

              var newLatOffset = (latOffset * cos - lonOffset * sin) * scaleMult;
              var newLonOffset = (latOffset * sin + lonOffset * cos) * scaleMult;

              return L.latLng(center.lat + newLatOffset, center.lng + newLonOffset);
            };

            if (Array.isArray(lls[0])) {
              var newLls = lls[0].map(rotatePoint);
              layer.setLatLngs([newLls]);
            } else {
              var newLls = lls.map(rotatePoint);
              layer.setLatLngs(newLls);
            }
          }
        }
      });
    }

    function onTouchMove(e) {
      if (mode !== 'templates') return;

      var touches = e.touches || e.originalEvent.touches;
      if (touches.length === 1 && activeDrag && activeDrag.type === 'boundary') {
        if (e.cancelable) e.preventDefault();
        var latlng = map.mouseEventToLatLng(touches[0]);
        onMouseMove({ latlng: latlng });
      } else if (touches.length === 1 && activeDrag) {
        var latlng = map.mouseEventToLatLng(touches[0]);
        onMouseMove({ latlng: latlng });
      } else if (touches.length === 1 && !activeDrag) {
        var nowMove = Date.now();
        if (nowMove - lastBoundaryDebugMoveLog > 500) {
          lastBoundaryDebugMoveLog = nowMove;
          debugBoundary('onTouchMove_noActiveDrag', {
            touchCount: touches.length,
            mapDraggingEnabled: map.dragging && map.dragging.enabled(),
            note: 'Leaflet map pan may be active'
          });
        }
      } else if (touches.length === 2 && touchState && !lockPanDrag) {
        var p1 = map.mouseEventToContainerPoint(touches[0]);
        var p2 = map.mouseEventToContainerPoint(touches[1]);
        var dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        var angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

        var scaleMult = dist / touchState.initialDist;
        var angleDelta = (angle - touchState.initialAngle) * 180 / Math.PI;

        var modeSetting = multiTouchMode;
        var appliedScale = modeSetting === 'rotate' ? 1 : scaleMult;
        var appliedRot = modeSetting === 'scale' ? 0 : angleDelta;

        touchState.lastScale = appliedScale;
        touchState.lastRotation = appliedRot;

        updatePinchVisuals(appliedScale, appliedRot);
      }
    }

    function onTouchEnd(e) {
      if (touchState) {
        var scaleDiff = Math.abs(1.0 - touchState.lastScale);
        var rotDiff = Math.abs(touchState.lastRotation);

        // Only send update if meaningful scale or rotation occurred.
        if (scaleDiff > 0.02 || rotDiff > 1.0) {
          var updates = touchState.itemsStart.map(function(start) {
            return {
              id: start.id,
              scale: start.scale * touchState.lastScale,
              rotation: (start.rotation + touchState.lastRotation) % 360
            };
          });

          postMessage({ type: 'itemsPinched', updates: updates });
        }

        touchState = null;
        if (!lockPanDrag) {
          map.dragging.enable();
        }
        if (!lockZoom) {
          map.touchZoom.enable();
        }
      } else if (activeDrag) {
        var touches = e.touches || (e.originalEvent && e.originalEvent.touches);
        if (!touches || touches.length === 0) {
          var changed = e.changedTouches || (e.originalEvent && e.originalEvent.changedTouches);
          if (changed && changed.length > 0) {
            onMouseUp({ latlng: map.mouseEventToLatLng(changed[0]) });
          } else {
            onMouseUp({ latlng: activeDrag.startLatlng });
          }
        }
      }
    }

    map.on('dragstart', function() {
      if (
        mode === 'templates' &&
        (boundaryDragHandleLatLng || (activeDrag && activeDrag.type === 'items'))
      ) {
        map.dragging.disable();
        debugBoundary('leaflet_dragstart_blocked', {
          reason: boundaryDragHandleLatLng ? 'boundary_selected' : 'item_drag_active',
          activeDrag: activeDrag ? activeDrag.type : null
        });
        return;
      }
      debugBoundary('leaflet_dragstart', {
        activeDrag: activeDrag ? activeDrag.type : null,
        mode: mode,
        lockPanDrag: lockPanDrag,
        mapDraggingEnabled: map.dragging && map.dragging.enabled()
      });
    });

    map.on('dragend', function() {
      debugBoundary('leaflet_dragend', {
        activeDrag: activeDrag ? activeDrag.type : null
      });
    });

    var mapContainer = map.getContainer();
    mapContainer.addEventListener('touchstart', onContainerTouchStart, { passive: false, capture: true });
    mapContainer.addEventListener('touchmove', onContainerTouchMove, { passive: false, capture: true });
    mapContainer.addEventListener('touchend', onContainerTouchEnd, { passive: false, capture: true });
    mapContainer.addEventListener('touchcancel', onContainerTouchEnd, { passive: false, capture: true });

    // Hook listeners
    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    map.on('touchstart', onTouchStart);
    map.on('touchmove', onTouchMove);
    map.on('touchend', onTouchEnd);

    // Lock Helper setters
    function setLockPanDrag(locked) {
      syncTemplatesMapDragging();
    }

    function setLockZoom(locked) {
      if (locked) {
        map.doubleClickZoom.disable();
        map.scrollWheelZoom.disable();
        map.touchZoom.disable();
      } else {
        map.doubleClickZoom.enable();
        map.scrollWheelZoom.enable();
        map.touchZoom.enable();
      }
    }

    // ── Message Handler ──
    function handleMessage(event) {
      try {
        var data = JSON.parse(event.data);

        if (data.type === 'updateRover') {
          updateRover(data.lat, data.lon, data.heading, data.nextTarget);
        } else if (data.type === 'updatePlanLines') {
          updatePlanLines(data.lines);
        } else if (data.type === 'updateRefPoints') {
          updateRefPoints(data.points);
        } else if (data.type === 'updateRefPointLabels') {
          refPointLabelsVisible = !!data.visible;
          if (!refPointLabelsVisible && activeRefPointMarker) {
            activeRefPointMarker.closeTooltip();
            activeRefPointMarker = null;
          }
          updateRefPoints(currentRefPoints);
        } else if (data.type === 'recenter') {
          if (roverMarker) {
            map.setView(roverMarker.getLatLng(), map.getZoom());
          }
        } else if (data.type === 'fitPlan') {
          var allLatLngs = [];
          planLinesGroup.eachLayer(function(layer) {
            if (layer.getLatLngs) {
              var latlngs = layer.getLatLngs();
              if (Array.isArray(latlngs[0])) {
                for (var i = 0; i < latlngs.length; i++) {
                  allLatLngs = allLatLngs.concat(latlngs[i]);
                }
              } else {
                allLatLngs = allLatLngs.concat(latlngs);
              }
            }
          });
          if (allLatLngs.length > 0) {
            var bounds = L.latLngBounds(allLatLngs);
            map.fitBounds(bounds, { padding: [40, 40] });
          }
        } else if (data.type === 'updatePlacedItems') {
          // Protect active drags from being destroyed by React Native state updates.
          if ((activeDrag && activeDrag.type === 'items') || touchState) {
            currentItems.forEach(function(oldItem) {
              var newItem = data.items.find(function(it) { return it.id === oldItem.id; });
              if (newItem) {
                oldItem.selected = newItem.selected;
              }
            });

            itemLayersGroup.eachLayer(function(layer) {
              var item = currentItems.find(function(it) { return it.id === layer._itemId; });
              if (item) {
                if (layer instanceof L.Polygon) {
                  layer.setStyle({
                    color: item.selected ? '#ef4444' : '#3b82f6',
                    fillColor: item.selected ? '#ef4444' : '#3b82f6',
                    fillOpacity: item.selected ? 0.05 : 0.02,
                    dashArray: item.selected ? '' : '4 4'
                  });
                } else if (layer instanceof L.Polyline) {
                  layer.setStyle({
                    opacity: sketchMode && !item.selected ? 0.2 : (item.selected ? 1.0 : 0.8)
                  });
                }
              }
            });
            return;
          }

          renderPlacedItems(data.items);
        } else if (data.type === 'updateBoundary') {
          boundaryControlPointsData = data.boundaryControlPoints || [];
          // ensure the drag handles are reset
          if (activeDrag && activeDrag.type === 'boundary') return;
          renderBoundary(data.boundary, data.boundaryControlPoints, data.isBoundarySelected, data.selectedBoundaryEdge);
          if (showBoundaryPoints) {
            renderBoundaryControlPoints(boundaryControlPointsData, activeSnapPointId);
          }
        } else if (data.type === 'updateShowBoundaryPoints') {
          showBoundaryPoints = !!data.showBoundaryPoints;
          if (!showBoundaryPoints) {
            boundaryPointsGroup.clearLayers();
          } else {
            renderBoundaryControlPoints(boundaryControlPointsData, activeSnapPointId);
          }
        } else if (data.type === 'updateActiveSnapPoint') {
          activeSnapPointId = data.activeSnapPointId || null;
          if (showBoundaryPoints) {
            renderBoundaryControlPoints(boundaryControlPointsData, activeSnapPointId);
          }
        } else if (data.type === 'updateSketchMode') {
          sketchMode = data.sketchMode;
          if (mode === 'templates') {
            renderPlacedItems(currentItems);
          }
        } else if (data.type === 'updateLocks') {
          lockPanDrag = data.lockPanDrag;
          lockZoom = data.lockZoom;
          setLockPanDrag(lockPanDrag);
          setLockZoom(lockZoom);
        } else if (data.type === 'updateMultiTouchMode') {
          multiTouchMode = data.multiTouchMode;
        } else if (data.type === 'updateSelection') {
          updateSelection(data);
        } else if (data.type === 'clearSelection') {
          clearSelection();
        } else if (data.type === 'setMode') {
          mode = data.mode;
          syncTemplatesMapDragging();
        }
      } catch (e) {
        console.error('MapView message error:', e);
      }
    }

    // Listen for RN WebView messages
    document.addEventListener('message', handleMessage);
    window.addEventListener('message', handleMessage);
  </script>
</body>
</html>
`;

const LAYER_COLORS: Record<string, string> = {
  boundary: "#0f172a",
  marking: "#16a34a",
  marking_false: "#86efac",
  center: "#f59e0b",
  transit: "#94a3b8",
  extension: "#8b5cf6",
};

export function MapView({
  telemetrySnapshot,
  lines,
  alignedRefPoints,
  visible,
  recenterRoverTrigger,
  recenterPlanTrigger,
  onSelectPoint,
  onSelectLine,
  selectedLineId = null,
  showCornerPoints = false,
  mode = "fields",
  placedItems = [],
  selectedItemIds = [],
  lockPanDrag = false,
  lockZoom = false,
  boundaryWidth,
  boundaryHeight,
  indentSpacing,
  sketchMode = false,
  showRefPointLabels = false,
  boundaryPosition,
  onMoveBoundary,
  showBoundaryPoints = false,
  activeSnapPointId = null,
  onPlaceRoverAtPoint,
  onUpdatePlacedItem,
  onUpdatePlacedItems,
  onSelectionChange,
  multiTouchMode = "both",

}: MapViewProps) {
  const webViewRef = useRef<WebView | null>(null);
  const lastRoverMsgRef = useRef("");
  const lastLinesMsgRef = useRef("");
  const lastRefMsgRef = useRef("");
  const lastPlacedItemsMsgRef = useRef("");
  const webViewReadyRef = useRef(false);

  const [latchedOrigin, setLatchedOrigin] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    if (!visible) {
      setLatchedOrigin(null);
      return;
    }
    if (telemetrySnapshot?.lat != null && telemetrySnapshot?.lon != null && !latchedOrigin) {
      setLatchedOrigin({ lat: telemetrySnapshot.lat, lon: telemetrySnapshot.lon });
    }
  }, [visible, telemetrySnapshot?.lat, telemetrySnapshot?.lon, latchedOrigin]);

  // Helper to resolve origin coordinates
  const origin = useMemo(() => {
    let originLat = 28.6139;
    let originLon = 77.2090;
    let originDxfX = 0;
    let originDxfY = 0;

    if (alignedRefPoints && alignedRefPoints.length > 0) {
      originLat = alignedRefPoints[0].lat;
      originLon = alignedRefPoints[0].lon;
      originDxfX = alignedRefPoints[0].dxf_x;
      originDxfY = alignedRefPoints[0].dxf_y;
    } else if (latchedOrigin != null) {
      originLat = latchedOrigin.lat;
      originLon = latchedOrigin.lon;
      originDxfX = 0;
      originDxfY = 0;
    }
    return { originLat, originLon, originDxfX, originDxfY };
  }, [alignedRefPoints, latchedOrigin]);

  // Helper to project a single PlanLine to GPS
  const projectLineToGps = useCallback((line: PlanLine) => {
    const coords: [number, number][] = [];
    if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
      for (const pt of line.entity.preview_points) {
        const gps = projectLocalMetersToGps(
          pt.north - origin.originDxfX,
          pt.east - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );
        coords.push([gps.lat, gps.lon]);
      }
    } else if (
      line.from &&
      line.to &&
      Number.isFinite(line.from.x) &&
      Number.isFinite(line.from.y) &&
      Number.isFinite(line.to.x) &&
      Number.isFinite(line.to.y)
    ) {
      const fromGps = projectLocalMetersToGps(
        line.from.x - origin.originDxfX,
        line.from.y - origin.originDxfY,
        origin.originLat,
        origin.originLon
      );
      const toGps = projectLocalMetersToGps(
        line.to.x - origin.originDxfX,
        line.to.y - origin.originDxfY,
        origin.originLat,
        origin.originLon
      );
      coords.push([fromGps.lat, fromGps.lon]);
      coords.push([toGps.lat, toGps.lon]);
    }
    return { coords, color: "#ef4444", weight: 4 };
  }, [origin]);

  // Helper to extract GPS vertices for corner point indicators of a line
  const getCornerPointsForLine = useCallback((line: PlanLine) => {
    const points: { lat: number; lon: number }[] = [];
    if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
      for (const pt of line.entity.preview_points) {
        const gps = projectLocalMetersToGps(
          pt.north - origin.originDxfX,
          pt.east - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );
        points.push({ lat: gps.lat, lon: gps.lon });
      }
    } else if (
      line.from &&
      line.to &&
      Number.isFinite(line.from.x) &&
      Number.isFinite(line.from.y) &&
      Number.isFinite(line.to.x) &&
      Number.isFinite(line.to.y)
    ) {
      const fromGps = projectLocalMetersToGps(
        line.from.x - origin.originDxfX,
        line.from.y - origin.originDxfY,
        origin.originLat,
        origin.originLon
      );
      const toGps = projectLocalMetersToGps(
        line.to.x - origin.originDxfX,
        line.to.y - origin.originDxfY,
        origin.originLat,
        origin.originLon
      );
      points.push({ lat: fromGps.lat, lon: fromGps.lon });
      points.push({ lat: toGps.lat, lon: toGps.lon });
    }
    return points;
  }, [origin]);

  // ── Projected plan lines (DXF → GPS) ──
  const projectedPlanLines = useMemo(() => {
    if (mode === "templates") {
      return [];
    }
    if (lines.length === 0) {
      return [];
    }

    const result: { coords: [number, number][]; color: string; weight: number }[] = [];

    for (const line of lines) {
      const color = LAYER_COLORS[line.layer] || "#0f172a";
      const weight = 2;

      // If entity has preview_points, use those for curved paths
      if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
        const coords: [number, number][] = [];
        for (const pt of line.entity.preview_points) {
          const gps = projectLocalMetersToGps(
            pt.north - origin.originDxfX,
            pt.east - origin.originDxfY,
            origin.originLat,
            origin.originLon
          );
          coords.push([gps.lat, gps.lon]);
        }
        result.push({ coords, color, weight });
      } else if (
        line.from &&
        line.to &&
        Number.isFinite(line.from.x) &&
        Number.isFinite(line.from.y) &&
        Number.isFinite(line.to.x) &&
        Number.isFinite(line.to.y)
      ) {
        const fromGps = projectLocalMetersToGps(
          line.from.x - origin.originDxfX,
          line.from.y - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );
        const toGps = projectLocalMetersToGps(
          line.to.x - origin.originDxfX,
          line.to.y - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );
        result.push({
          coords: [
            [fromGps.lat, fromGps.lon],
            [toGps.lat, toGps.lon],
          ],
          color,
          weight,
        });
      }
    }

    return result;
  }, [lines, origin, mode]);

  // ── Projected boundary box (Templates Mode) ──
  const projectedBoundary = useMemo(() => {
    if (!boundaryWidth || !boundaryHeight) return null;

    const bpX = boundaryPosition?.x || 0;
    const bpY = boundaryPosition?.y || 0;
    const halfW = boundaryWidth / 2;
    const halfH = boundaryHeight / 2;

    const outerDxfPoints = [
      { north: bpY - halfH, east: bpX - halfW },
      { north: bpY - halfH, east: bpX + halfW },
      { north: bpY + halfH, east: bpX + halfW },
      { north: bpY + halfH, east: bpX - halfW },
      { north: bpY - halfH, east: bpX - halfW },
    ];

    const outerGps = outerDxfPoints.map((pt) => {
      const gps = projectLocalMetersToGps(
        pt.north - origin.originDxfX,
        pt.east - origin.originDxfY,
        origin.originLat,
        origin.originLon
      );
      return [gps.lat, gps.lon] as [number, number];
    });

    let indentGps: [number, number][] = [];
    if (indentSpacing && indentSpacing > 0) {
      const indW = halfW - indentSpacing;
      const indH = halfH - indentSpacing;
      if (indW > 0 && indH > 0) {
        const indentDxfPoints = [
          { north: bpY - indH, east: bpX - indW },
          { north: bpY - indH, east: bpX + indW },
          { north: bpY + indH, east: bpX + indW },
          { north: bpY + indH, east: bpX - indW },
          { north: bpY - indH, east: bpX - indW },
        ];
        indentGps = indentDxfPoints.map((pt) => {
          const gps = projectLocalMetersToGps(
            pt.north - origin.originDxfX,
            pt.east - origin.originDxfY,
            origin.originLat,
            origin.originLon
          );
          return [gps.lat, gps.lon] as [number, number];
        });
      }
    }

    return {
      outer: outerGps,
      indent: indentGps.length > 0 ? indentGps : null,
    };
  }, [boundaryWidth, boundaryHeight, indentSpacing, origin, boundaryPosition]);

  const projectedBoundaryControlPoints = useMemo(() => {
    if (!showBoundaryPoints || !projectedBoundary?.outer || projectedBoundary.outer.length < 4) return [];
    const pts = projectedBoundary.outer;
    const midpoint = (p1: [number, number], p2: [number, number]) => [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] as [number, number];
    return [
      { id: 'corner-tl', latlng: pts[0] },
      { id: 'corner-tr', latlng: pts[1] },
      { id: 'corner-br', latlng: pts[2] },
      { id: 'corner-bl', latlng: pts[3] },
      { id: 'midpoint-t', latlng: midpoint(pts[0], pts[1]) },
      { id: 'midpoint-r', latlng: midpoint(pts[1], pts[2]) },
      { id: 'midpoint-b', latlng: midpoint(pts[2], pts[3]) },
      { id: 'midpoint-l', latlng: midpoint(pts[3], pts[0]) },
    ];
  }, [projectedBoundary, showBoundaryPoints]);

  // ── Projected placed items (Templates Mode) ──
  const projectedPlacedItems = useMemo(() => {
    if (!placedItems || placedItems.length === 0) return [];

    return placedItems.map((item) => {
      const cos = Math.cos((item.rotation || 0) * Math.PI / 180);
      const sin = Math.sin((item.rotation || 0) * Math.PI / 180);

      // Project each line's endpoints to GPS
      const linesGps = item.lines.map((l) => {
        const fromPlaced = transformVisualDxfPoint(l.from.x, l.from.y, item);
        const toPlaced = transformVisualDxfPoint(l.to.x, l.to.y, item);
        const fromNorth = fromPlaced.north;
        const fromEast = fromPlaced.east;
        const toNorth = toPlaced.north;
        const toEast = toPlaced.east;

        const fromGps = projectLocalMetersToGps(
          fromNorth - origin.originDxfX,
          fromEast - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );
        const toGps = projectLocalMetersToGps(
          toNorth - origin.originDxfX,
          toEast - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );

        return {
          from: { lat: fromGps.lat, lon: fromGps.lon },
          to: { lat: toGps.lat, lon: toGps.lon },
        };
      });

      // Bounding box corners: centered at item.y (North), item.x (East)
      const halfLocalNorth = item.height / 2; // North-South
      const halfLocalEast = item.width / 2; // East-West

      const cornersLocal = [
        { n: -halfLocalNorth, e: -halfLocalEast },
        { n: -halfLocalNorth, e: halfLocalEast },
        { n: halfLocalNorth, e: halfLocalEast },
        { n: halfLocalNorth, e: -halfLocalEast },
      ];

      const boxGps = cornersLocal.map((c) => {
        const n = (c.n * cos - c.e * sin) * item.scale + item.y;
        const e = (c.n * sin + c.e * cos) * item.scale + item.x;
        const gps = projectLocalMetersToGps(
          n - origin.originDxfX,
          e - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );
        return [gps.lat, gps.lon] as [number, number];
      });

      // Center in GPS for rotation anchors
      const centerGps = projectLocalMetersToGps(
        item.y - origin.originDxfX,
        item.x - origin.originDxfY,
        origin.originLat,
        origin.originLon
      );

      return {
        id: item.id,
        x: item.x,
        y: item.y,
        rotation: item.rotation,
        scale: item.scale,
        width: item.width,
        height: item.height,
        lines: linesGps,
        box: boxGps,
        center: { lat: centerGps.lat, lon: centerGps.lon },
        selected: selectedItemIds?.includes(item.id) ?? false,
      };
    });
  }, [placedItems, selectedItemIds, origin]);

  // ── Send data to WebView ──
  const sendToWebView = useCallback(
    (msg: object) => {
      if (!webViewReadyRef.current || !webViewRef.current) return;
      try {
        webViewRef.current.postMessage(JSON.stringify(msg));
      } catch {
        // WebView may have been unmounted
      }
    },
    []
  );

  // Send recenter commands
  useEffect(() => {
    if (!visible) return;
    if (recenterRoverTrigger && recenterRoverTrigger > 0) {
      sendToWebView({ type: "recenter" });
    }
  }, [recenterRoverTrigger, visible, sendToWebView]);

  useEffect(() => {
    if (!visible) return;
    if (recenterPlanTrigger && recenterPlanTrigger > 0) {
      sendToWebView({ type: "fitPlan" });
    }
  }, [recenterPlanTrigger, visible, sendToWebView]);

  // Send rover position updates
  useEffect(() => {
    if (!visible) return;

    const lat = telemetrySnapshot?.lat;
    const lon = telemetrySnapshot?.lon;
    const heading = telemetrySnapshot?.heading_ned_deg;
    
    let nextTargetGps = null;
    if (telemetrySnapshot?.pos_n != null && telemetrySnapshot?.pos_e != null && lines.length > 0 && origin.originLat) {
      const realN = telemetrySnapshot.pos_n;
      const realE = telemetrySnapshot.pos_e;
      let nextDist = Infinity;
      let nextTarget = null;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.from || !line.to) continue;
        const segStart = { x: line.from.x, y: line.from.y };
        const segEnd = { x: line.to.x, y: line.to.y };

        const segDx = segEnd.x - segStart.x;
        const segDy = segEnd.y - segStart.y;
        const segLen2 = segDx * segDx + segDy * segDy;
        if (segLen2 === 0) continue;

        const t = ((realN - segStart.x) * segDx + (realE - segStart.y) * segDy) / segLen2;
        const targetPt = t <= 0.5
          ? { x: segEnd.x, y: segEnd.y }
          : (i < lines.length - 1 ? { x: lines[i + 1].from.x, y: lines[i + 1].from.y } : { x: segEnd.x, y: segEnd.y });
        const targetDist = Math.hypot(targetPt.x - realN, targetPt.y - realE);
        nextDist = targetDist;
        nextTarget = targetPt;
        break;
      }
      
      if (nextTarget && nextDist < 100) {
        nextTargetGps = projectLocalMetersToGps(
          nextTarget.x - origin.originDxfX,
          nextTarget.y - origin.originDxfY,
          origin.originLat,
          origin.originLon
        );
      }
    }

    sendToWebView({
      type: "updateRover",
      lat: lat ?? null,
      lon: lon ?? null,
      heading: heading ?? null,
      nextTarget: nextTargetGps,
    });
  }, [
    visible,
    telemetrySnapshot?.lat,
    telemetrySnapshot?.lon,
    telemetrySnapshot?.heading_ned_deg,
    telemetrySnapshot?.pos_n,
    telemetrySnapshot?.pos_e,
    showRefPointLabels,
    lines,
    origin,
    projectLocalMetersToGps,
    sendToWebView,
  ]);

  // Send projected plan lines
  useEffect(() => {
    if (!visible) return;

    const msgKey = buildPlanLinesMsgKey(lines, origin.originLat, origin.originLon);
    if (msgKey === lastLinesMsgRef.current) return;
    lastLinesMsgRef.current = msgKey;

    sendToWebView({
      type: "updatePlanLines",
      lines: projectedPlanLines,
    });
  }, [visible, projectedPlanLines, lines, origin.originLat, origin.originLon, sendToWebView]);

  // Send reference points
  useEffect(() => {
    if (!visible) return;

    const msgKey = `${alignedRefPoints.length}:${alignedRefPoints
      .map((p) => `${p.lat}:${p.lon}`)
      .join(",")}`;
    if (msgKey === lastRefMsgRef.current) return;
    lastRefMsgRef.current = msgKey;

    sendToWebView({
      type: "updateRefPoints",
      points: alignedRefPoints,
    });
  }, [visible, alignedRefPoints, sendToWebView]);

  useEffect(() => {
    if (!visible) return;
    sendToWebView({
      type: "updateRefPointLabels",
      visible: showRefPointLabels,
    });
  }, [visible, showRefPointLabels, sendToWebView]);

  // Sync mode to WebView
  useEffect(() => {
    if (!visible) return;
    sendToWebView({ type: "setMode", mode });
  }, [mode, visible, sendToWebView]);

  // Sync Fields mode selection to WebView
  useEffect(() => {
    if (!visible || mode !== "fields") return;
    const selectedLine = lines.find((l) => l.id === selectedLineId);
    if (selectedLine) {
      const projected = projectLineToGps(selectedLine);
      const cornerPts = getCornerPointsForLine(selectedLine);
      sendToWebView({
        type: "updateSelection",
        line: projected,
        cornerPoints: cornerPts,
      });
    } else {
      sendToWebView({ type: "clearSelection" });
    }
  }, [selectedLineId, lines, visible, mode, projectLineToGps, getCornerPointsForLine, sendToWebView]);

  // Sync Templates mode placed items to WebView
  useEffect(() => {
    if (!visible || mode !== "templates") return;
    const msgKey = projectedPlacedItems
      .map((item) =>
        `${item.id}:${item.x}:${item.y}:${item.rotation}:${item.scale}:${item.lines.length}`
      )
      .join("|");
    if (msgKey === lastPlacedItemsMsgRef.current) return;
    lastPlacedItemsMsgRef.current = msgKey;

    sendToWebView({
      type: "updatePlacedItems",
      items: projectedPlacedItems,
    });
  }, [projectedPlacedItems, visible, mode, sendToWebView]);

  // Sync Templates mode boundary box to WebView
  useEffect(() => {
    if (!visible || mode !== "templates") return;
    sendToWebView({
      type: "updateBoundary",
      boundary: projectedBoundary,
      boundaryControlPoints: projectedBoundaryControlPoints,
      isBoundarySelected: selectedItemIds.includes("boundary"),
    });
  }, [projectedBoundary, projectedBoundaryControlPoints, selectedItemIds, visible, mode, sendToWebView]);

  useEffect(() => {
    if (!visible || mode !== "templates") return;
    sendToWebView({
      type: "updateActiveSnapPoint",
      activeSnapPointId,
    });
  }, [activeSnapPointId, visible, mode, sendToWebView]);

  useEffect(() => {
    if (!visible || mode !== "templates") return;
    sendToWebView({
      type: "updateShowBoundaryPoints",
      showBoundaryPoints,
    });
  }, [showBoundaryPoints, visible, mode, sendToWebView]);

  // Sync Templates mode lock states to WebView
  useEffect(() => {
    if (!visible || mode !== "templates") return;
    sendToWebView({
      type: "updateLocks",
      lockPanDrag,
      lockZoom,
    });
  }, [lockPanDrag, lockZoom, visible, mode, sendToWebView]);

  // Sync Templates mode multiTouchMode state to WebView
  useEffect(() => {
    if (!visible || mode !== "templates") return;
    sendToWebView({
      type: "updateMultiTouchMode",
      multiTouchMode,
    });
  }, [multiTouchMode, visible, mode, sendToWebView]);

  const handleWebViewLoad = useCallback(() => {
    webViewReadyRef.current = true;
    
    // Capture state at load time and send immediately
    const lat = telemetrySnapshot?.lat;
    const lon = telemetrySnapshot?.lon;
    const heading = telemetrySnapshot?.heading_ned_deg;

    try {
      webViewRef.current?.postMessage(
        JSON.stringify({
          type: "setMode",
          mode,
        })
      );
    } catch (e) {}

    if (lat != null && lon != null) {
      try {
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updateRover",
            lat,
            lon,
            heading: heading ?? null,
          })
        );
      } catch (e) {}
      lastRoverMsgRef.current = `${lat}:${lon}:${heading}`;
    }

    if (projectedPlanLines.length > 0) {
      try {
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updatePlanLines",
            lines: projectedPlanLines,
          })
        );
      } catch (e) {}
      lastLinesMsgRef.current = buildPlanLinesMsgKey(lines, origin.originLat, origin.originLon);
    }

    if (alignedRefPoints.length > 0) {
      try {
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updateRefPoints",
            points: alignedRefPoints,
          })
        );
      } catch (e) {}
      lastRefMsgRef.current = `${alignedRefPoints.length}:${alignedRefPoints
        .map((p) => `${p.lat}:${p.lon}`)
        .join(",")}`;
    }

    try {
      webViewRef.current?.postMessage(
        JSON.stringify({
          type: "updateRefPointLabels",
          visible: showRefPointLabels,
        })
      );
    } catch (e) {}

    if (mode === "fields") {
      const selectedLine = lines.find((l) => l.id === selectedLineId);
      if (selectedLine) {
        try {
          webViewRef.current?.postMessage(
            JSON.stringify({
              type: "updateSelection",
              line: projectLineToGps(selectedLine),
              cornerPoints: getCornerPointsForLine(selectedLine),
            })
          );
        } catch (e) {}
      }
    } else if (mode === "templates") {
      if (projectedBoundary) {
        try {
          webViewRef.current?.postMessage(
            JSON.stringify({
              type: "updateBoundary",
              boundary: projectedBoundary,
              boundaryControlPoints: projectedBoundaryControlPoints,
              isBoundarySelected: selectedItemIds.includes("boundary"),
            })
          );
        } catch (e) {}
      }
      try {
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updateActiveSnapPoint",
            activeSnapPointId,
          })
        );
      } catch (e) {}
      try {
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updateShowBoundaryPoints",
            showBoundaryPoints,
          })
        );
      } catch (e) {}
      if (projectedPlacedItems.length > 0) {
        try {
          webViewRef.current?.postMessage(
            JSON.stringify({
              type: "updatePlacedItems",
              items: projectedPlacedItems,
            })
          );
        } catch (e) {}
      }
      try {
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updateLocks",
            lockPanDrag,
            lockZoom,
          })
        );
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updateMultiTouchMode",
            multiTouchMode,
          })
        );
      } catch (e) {}
      try {
        webViewRef.current?.postMessage(
          JSON.stringify({
            type: "updateSketchMode",
            sketchMode,
          })
        );
      } catch (e) {}
    }
  }, [
    telemetrySnapshot,
    projectedPlanLines,
    alignedRefPoints,
    origin.originLat,
    origin.originLon,
    lines,
    mode,
    selectedLineId,
    projectLineToGps,
    getCornerPointsForLine,
    projectedBoundary,
    projectedBoundaryControlPoints,
    selectedItemIds,
    projectedPlacedItems,
    lockPanDrag,
    lockZoom,
    multiTouchMode,
    sketchMode,
    showBoundaryPoints,
    activeSnapPointId,
    showRefPointLabels,
  ]); 

  const handleWebViewMessage = useCallback(
    (event: any) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === "mapClick") {
          if (mode === "templates") {
            onSelectionChange?.([]);
            return;
          }

          const { lat, lon } = data;

          let originLat = 0;
          let originLon = 0;
          let originDxfX = 0;
          let originDxfY = 0;

          if (alignedRefPoints && alignedRefPoints.length > 0) {
            originLat = alignedRefPoints[0].lat;
            originLon = alignedRefPoints[0].lon;
            originDxfX = alignedRefPoints[0].dxf_x;
            originDxfY = alignedRefPoints[0].dxf_y;
          } else if (latchedOrigin != null) {
            originLat = latchedOrigin.lat;
            originLon = latchedOrigin.lon;
            originDxfX = 0;
            originDxfY = 0;
          } else {
            originLat = 28.6139;
            originLon = 77.2090;
            originDxfX = 0;
            originDxfY = 0;
          }

          const local = projectGpsToLocalMeters(lat, lon, originLat, originLon);
          const clickedDxfX = local.north + originDxfX;
          const clickedDxfY = local.east + originDxfY;

          // 1. Try to find the nearest point/vertex
          let bestPt: { x: number; y: number } | null = null;
          let bestPtDist = Infinity;
          const ptThreshold = 2.0; // 2.0 meters tolerance

          for (const line of lines) {
            if (line.from) {
              const d = Math.hypot(line.from.x - clickedDxfX, line.from.y - clickedDxfY);
              if (d < bestPtDist) {
                bestPtDist = d;
                bestPt = { x: line.from.x, y: line.from.y };
              }
            }
            if (line.to) {
              const d = Math.hypot(line.to.x - clickedDxfX, line.to.y - clickedDxfY);
              if (d < bestPtDist) {
                bestPtDist = d;
                bestPt = { x: line.to.x, y: line.to.y };
              }
            }
            if (line.entity?.preview_points) {
              for (const pt of line.entity.preview_points) {
                const d = Math.hypot(pt.north - clickedDxfX, pt.east - clickedDxfY);
                if (d < bestPtDist) {
                  bestPtDist = d;
                  bestPt = { x: pt.north, y: pt.east };
                }
              }
            }
          }

          if (bestPt && bestPtDist < ptThreshold && onSelectPoint) {
            onSelectPoint({ x: bestPt.y, y: bestPt.x });
            return;
          }

          // 2. Try to find the nearest line
          let bestLineId: string | null = null;
          let bestLineDist = Infinity;
          const lineThreshold = 3.5; // 3.5 meters tolerance

          for (const line of lines) {
            let dist = Infinity;
            if (line.entity?.preview_points && line.entity.preview_points.length >= 2) {
              for (let i = 0; i < line.entity.preview_points.length - 1; i++) {
                const p1 = line.entity.preview_points[i];
                const p2 = line.entity.preview_points[i + 1];
                const d = distToSegment(clickedDxfX, clickedDxfY, p1.north, p1.east, p2.north, p2.east);
                if (d < dist) dist = d;
              }
            } else if (line.from && line.to) {
              dist = distToSegment(clickedDxfX, clickedDxfY, line.from.x, line.from.y, line.to.x, line.to.y);
            }

            if (dist < bestLineDist) {
              bestLineDist = dist;
              bestLineId = line.id;
            }
          }

          if (bestLineId && bestLineDist < lineThreshold && onSelectLine) {
            onSelectLine(bestLineId);
          } else if (onSelectLine) {
            onSelectLine(null);
          }
        } else if (data.type === "selectItems") {
          onSelectionChange?.(data.ids);
        } else if (data.type === "boundaryDragDebug") {
          console.log(
            `[MapView BoundaryDrag] ${data.stage}`,
            data.payload ?? {},
            `(ts=${data.ts})`
          );
        } else if (data.type === "itemsMoved") {
          const bw = boundaryWidth ?? 0;
          const bh = boundaryHeight ?? 0;
          const indent = indentSpacing ?? 0;

          const bpX = boundaryPosition?.x || 0;
          const bpY = boundaryPosition?.y || 0;

          const leftIndent = bpX - bw / 2 + indent;
          const rightIndent = bpX + bw / 2 - indent;
          const topIndent = bpY - bh / 2 + indent;
          const bottomIndent = bpY + bh / 2 - indent;

          const updatedItems = placedItems.map((item) => {
            const update = data.updates.find((u: any) => u.id === item.id);
            if (update) {
              const halfW = item.width / 2;
              const halfH = item.height / 2;
              let newX = update.x;
              let newY = update.y;

              // Clamp inside boundary indent
              if (bw > 0 && bh > 0) {
                newX = Math.max(leftIndent + halfW, Math.min(newX, rightIndent - halfW));
                newY = Math.max(topIndent + halfH, Math.min(newY, bottomIndent - halfH));
              }

              return { ...item, x: newX, y: newY };
            }
            return item;
          });

          if (onUpdatePlacedItems) {
            onUpdatePlacedItems(updatedItems);
          } else if (onUpdatePlacedItem) {
            data.updates.forEach((update: any) => {
              const item = updatedItems.find((it) => it.id === update.id);
              if (item) {
                onUpdatePlacedItem(update.id, { x: item.x, y: item.y });
              }
            });
          }
        } else if (data.type === "itemsPinched") {
          const bw = boundaryWidth ?? 0;
          const bh = boundaryHeight ?? 0;
          const indent = indentSpacing ?? 0;

          const bpX = boundaryPosition?.x || 0;
          const bpY = boundaryPosition?.y || 0;

          const leftIndent = bpX - bw / 2 + indent;
          const rightIndent = bpX + bw / 2 - indent;
          const topIndent = bpY - bh / 2 + indent;
          const bottomIndent = bpY + bh / 2 - indent;

          const updatedItems = placedItems.map((item) => {
            const update = data.updates.find((u: any) => u.id === item.id);
            if (update) {
              const scaleRatio = update.scale / item.scale;
              const newW = item.width * scaleRatio;
              const newH = item.height * scaleRatio;

              let newX = item.x;
              let newY = item.y;

              // Clamp inside boundary indent
              if (bw > 0 && bh > 0) {
                newX = Math.max(leftIndent + newW / 2, Math.min(newX, rightIndent - newW / 2));
                newY = Math.max(topIndent + newH / 2, Math.min(newY, bottomIndent - newH / 2));
              }

              // Update lines
              const scaledLines = item.lines.map((l) => ({
                ...l,
                from: { ...l.from, x: l.from.x * scaleRatio, y: l.from.y * scaleRatio },
                to: { ...l.to, x: l.to.x * scaleRatio, y: l.to.y * scaleRatio },
              }));

              return {
                ...item,
                scale: update.scale,
                rotation: update.rotation,
                width: newW,
                height: newH,
                x: newX,
                y: newY,
                lines: scaledLines,
              };
            }
            return item;
          });

          if (onUpdatePlacedItems) {
            onUpdatePlacedItems(updatedItems);
          } else if (onUpdatePlacedItem) {
            data.updates.forEach((update: any) => {
              const item = updatedItems.find((it) => it.id === update.id);
              if (item) {
                onUpdatePlacedItem(update.id, {
                  scale: item.scale,
                  rotation: item.rotation,
                  width: item.width,
                  height: item.height,
                  x: item.x,
                  y: item.y,
                  lines: item.lines,
                });
              }
            });
          }
        } else if (data.type === "boundaryDragged") {
          const { latDelta, lonDelta } = data;
          if (typeof latDelta !== "number" || typeof lonDelta !== "number" || isNaN(latDelta) || isNaN(lonDelta)) {
            console.warn("[MapView BoundaryDrag] boundaryDragged rejected — invalid deltas", { latDelta, lonDelta });
            return;
          }

          const originLatRad = (origin.originLat * Math.PI) / 180;
          const dy = latDelta * (EARTH_RADIUS * Math.PI / 180);
          const dx = lonDelta * (EARTH_RADIUS * Math.cos(originLatRad) * Math.PI / 180);

          console.log("[MapView BoundaryDrag] boundaryDragged received", {
            latDelta,
            lonDelta,
            dxMeters: dx,
            dyMeters: dy,
            from: boundaryPosition,
            to: boundaryPosition ? { x: boundaryPosition.x + dx, y: boundaryPosition.y + dy } : null,
            hasOnMoveBoundary: !!onMoveBoundary,
          });

          if (onMoveBoundary && boundaryPosition) {
            onMoveBoundary(boundaryPosition.x + dx, boundaryPosition.y + dy);
          } else {
            console.warn("[MapView BoundaryDrag] boundaryDragged dropped", {
              hasOnMoveBoundary: !!onMoveBoundary,
              hasBoundaryPosition: !!boundaryPosition,
            });
          }
        } else if (data.type === "boundaryPointClicked") {
          if (onPlaceRoverAtPoint) {
            const local = projectGpsToLocalMeters(data.latlng.lat, data.latlng.lng, origin.originLat, origin.originLon);
            const dxfX = local.east + origin.originDxfX;
            const dxfY = local.north + origin.originDxfY;
            // North maps to Y, East maps to X
            onPlaceRoverAtPoint(data.pointId, dxfX, dxfY);
          }

        }
      } catch (e) {
        console.error("MapView handleMessage error:", e);
      }
    },
    [
      lines,
      alignedRefPoints,
      latchedOrigin,
      onSelectPoint,
      onSelectLine,
      mode,
      placedItems,
      selectedItemIds,
      boundaryWidth,
      boundaryHeight,
      indentSpacing,
      boundaryPosition,
      onMoveBoundary,
      onPlaceRoverAtPoint,
      onUpdatePlacedItem,
      onUpdatePlacedItems,
      onSelectionChange,
    ]
  );

  if (!visible) return null;

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        originWhitelist={["*"]}
        source={{ html: LEAFLET_HTML }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        onLoad={handleWebViewLoad}
        onMessage={handleWebViewMessage}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text style={styles.loadingText}>Loading Map…</Text>
          </View>
        )}
        nestedScrollEnabled
        scrollEnabled={false}
        overScrollMode="never"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    elevation: 10,
    borderRadius: 20,
    overflow: "hidden",
  },
  webview: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  loadingContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fafc",
    gap: 12,
  },
  loadingText: {
    color: "#64748b",
    fontSize: 13,
    fontWeight: "600",
  },
});
