/**
 * Orbit camera per ARCHITECTURE.md: WASD pan, Q/E rotate, R/F tilt, wheel zoom
 * to the cursor, middle or right drag orbit, all smoothed by damping.
 */
import * as THREE from 'three';
import { MAP_HALF_SIZE, terrainHeight } from '../core/terrain';
import type { CameraPose } from './api';

const MIN_DISTANCE = 7;
const MAX_DISTANCE = 6800;
const MIN_PITCH = 0.05;
const MAX_PITCH = 1.54;
const TARGET_MARGIN = 160;
/** A right press moving less than this is a click for the tools. */
const CLICK_SLOP_PX = 5;
const DAMP = 11;
const DAMP_ANIMATED = 3.2;

function damp(from: number, to: number, rate: number, dt: number): number {
  return to + (from - to) * Math.exp(-rate * dt);
}

function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return a - t * Math.round(a / t);
}

/** Inputs that take no typed characters, so camera keys still work while they hold focus. */
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** Checked on every key press rather than latched, so focus lost to a removed panel can't strand the camera. */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3(0, 0, 0);
  distance = 620;
  yaw = 0.5;
  pitch = 0.72;

  private goalTarget = this.target.clone();
  private goalDistance = this.distance;
  private goalYaw = this.yaw;
  private goalPitch = this.pitch;
  private animating = false;

  private keys = new Set<string>();
  keysEnabled = true;
  private speedBoost = false;

  private dragButton = -1;
  private dragStartX = 0;
  private dragStartY = 0;
  private lastX = 0;
  private lastY = 0;
  private dragged = false;
  private shiftPan = false;
  /** Stays true until the event after the release, so tools can check it on pointerup. */
  private wasDragged = false;
  private rightClick = new Set<(x: number, y: number, e: PointerEvent) => void>();

  /** World position the camera is locked onto, or null. */
  followPoint: THREE.Vector3 | null = null;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private cleanups: (() => void)[] = [];

  constructor(
    private readonly dom: HTMLElement,
    aspect: number,
  ) {
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.4, 40000);
    this.bind();
    this.apply();
  }

  private bind(): void {
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    const dom = this.dom;
    on(dom, 'contextmenu', (e) => e.preventDefault());
    on(dom, 'pointerdown', (e) => this.pointerDown(e));
    on(window, 'pointermove', (e) => this.pointerMove(e));
    on(window, 'pointerup', (e) => this.pointerUp(e));
    on(window, 'pointercancel', () => {
      this.dragButton = -1;
    });
    on(dom, 'wheel', (e) => this.wheel(e), { passive: false });
    on(window, 'keydown', (e) => this.keyDown(e));
    on(window, 'keyup', (e) => {
      this.keys.delete(e.code);
      this.speedBoost = e.shiftKey;
    });
    on(window, 'blur', () => this.keys.clear());
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 1 && e.button !== 2) return;
    if (e.button === 1) e.preventDefault();
    this.dragButton = e.button;
    this.dragStartX = this.lastX = e.clientX;
    this.dragStartY = this.lastY = e.clientY;
    this.dragged = false;
    this.wasDragged = false;
    this.shiftPan = e.button === 1 && e.shiftKey;
  }

  private pointerMove(e: PointerEvent): void {
    if (this.dragButton < 0) return;
    if (!this.dragged) {
      const moved = Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY);
      if (moved < CLICK_SLOP_PX) return;
      this.dragged = true;
      this.wasDragged = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.shiftPan) {
      const k = (this.distance * 2 * Math.tan((this.camera.fov * Math.PI) / 360)) / this.dom.clientHeight;
      this.panBy(-dx * k, dy * k / Math.max(Math.sin(this.pitch), 0.25));
      return;
    }
    this.animating = false;
    this.goalYaw -= dx * 0.0052;
    this.goalPitch = THREE.MathUtils.clamp(this.goalPitch + dy * 0.0042, MIN_PITCH, MAX_PITCH);
  }

  private pointerUp(e: PointerEvent): void {
    if (e.button !== this.dragButton) return;
    const wasClick = e.button === 2 && !this.dragged;
    this.dragButton = -1;
    this.dragged = false;
    if (wasClick) for (const fn of this.rightClick) fn(e.clientX, e.clientY, e);
    // Cleared after the event finishes, so handlers later in this same dispatch still see it.
    queueMicrotask(() => {
      setTimeout(() => {
        if (this.dragButton < 0) this.wasDragged = false;
      }, 0);
    });
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.animating = false;
    const steps = (e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) / 100;
    const factor = Math.pow(1.14, THREE.MathUtils.clamp(steps, -6, 6));
    const old = this.goalDistance;
    const next = THREE.MathUtils.clamp(old * factor, MIN_DISTANCE, MAX_DISTANCE);
    if (next === old) return;
    if (!this.followPoint) {
      const hit = this.rayToPlane(e.clientX, e.clientY, this.goalTarget.y);
      if (hit) {
        // Keep the point under the cursor in place. Near the horizon, limit the reach.
        const dx = hit.x - this.goalTarget.x;
        const dz = hit.z - this.goalTarget.z;
        const reach = Math.hypot(dx, dz);
        const limit = old * 3;
        const k = (1 - next / old) * (reach > limit ? limit / reach : 1);
        this.goalTarget.x += dx * k;
        this.goalTarget.z += dz * k;
        this.clampTarget(this.goalTarget);
      }
    }
    this.goalDistance = next;
  }

  private keyDown(e: KeyboardEvent): void {
    this.speedBoost = e.shiftKey;
    if (!this.keysEnabled || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(document.activeElement)) return;
    this.keys.add(e.code);
  }

  private clampTarget(v: THREE.Vector3): void {
    const lim = MAP_HALF_SIZE + TARGET_MARGIN;
    v.x = THREE.MathUtils.clamp(v.x, -lim, lim);
    v.z = THREE.MathUtils.clamp(v.z, -lim, lim);
  }

  private panBy(right: number, forward: number): void {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    this.goalTarget.x += c * right - s * forward;
    this.goalTarget.z += -s * right - c * forward;
    this.clampTarget(this.goalTarget);
  }

  /** True when the last right or middle press turned into an orbit. */
  get isDragging(): boolean {
    return this.wasDragged;
  }

  onRightClick(fn: (x: number, y: number, e: PointerEvent) => void): () => void {
    this.rightClick.add(fn);
    return () => this.rightClick.delete(fn);
  }

  setKeysEnabled(on: boolean): void {
    this.keysEnabled = on;
    if (!on) this.keys.clear();
  }

  getPose(): CameraPose {
    const t = this.target;
    return { target: { x: t.x, y: t.y, z: t.z }, distance: this.distance, yaw: this.yaw, pitch: this.pitch };
  }

  setPose(pose: Partial<CameraPose>, animate = false): void {
    if (pose.target) this.goalTarget.set(pose.target.x, pose.target.y, pose.target.z);
    this.clampTarget(this.goalTarget);
    if (pose.distance !== undefined) this.goalDistance = THREE.MathUtils.clamp(pose.distance, MIN_DISTANCE, MAX_DISTANCE);
    if (pose.yaw !== undefined) this.goalYaw = pose.yaw;
    if (pose.pitch !== undefined) this.goalPitch = THREE.MathUtils.clamp(pose.pitch, MIN_PITCH, MAX_PITCH);
    if (animate) {
      this.animating = true;
      return;
    }
    this.target.copy(this.goalTarget);
    this.distance = this.goalDistance;
    this.yaw = this.goalYaw;
    this.pitch = this.goalPitch;
    this.apply();
  }

  update(dt: number): void {
    const k = this.keys;
    if (k.size && this.keysEnabled) {
      const pan = this.goalDistance * (this.speedBoost ? 2.4 : 1.1) * dt + 2 * dt;
      let r = 0;
      let f = 0;
      if (k.has('KeyW')) f += pan;
      if (k.has('KeyS')) f -= pan;
      if (k.has('KeyD')) r += pan;
      if (k.has('KeyA')) r -= pan;
      if (r || f) {
        this.panBy(r, f);
        this.animating = false;
      }
      const spin = 1.5 * dt;
      if (k.has('KeyQ')) this.goalYaw += spin;
      if (k.has('KeyE')) this.goalYaw -= spin;
      if (k.has('KeyR')) this.goalPitch = Math.min(MAX_PITCH, this.goalPitch + spin * 0.75);
      if (k.has('KeyF')) this.goalPitch = Math.max(MIN_PITCH, this.goalPitch - spin * 0.75);
    }
    if (this.followPoint) this.goalTarget.copy(this.followPoint);

    const rate = this.animating ? DAMP_ANIMATED : DAMP;
    const followRate = this.followPoint ? 16 : rate;
    this.target.x = damp(this.target.x, this.goalTarget.x, followRate, dt);
    this.target.y = damp(this.target.y, this.goalTarget.y, followRate, dt);
    this.target.z = damp(this.target.z, this.goalTarget.z, followRate, dt);
    // Log space, so a long zoom feels even.
    this.distance = Math.exp(damp(Math.log(this.distance), Math.log(this.goalDistance), rate, dt));
    const dy = wrapAngle(this.goalYaw - this.yaw);
    this.yaw += dy * (1 - Math.exp(-rate * dt));
    this.pitch = damp(this.pitch, this.goalPitch, rate, dt);
    if (this.animating && Math.abs(this.distance - this.goalDistance) < 0.5 && Math.abs(dy) < 0.002) this.animating = false;
    this.apply();
  }

  private apply(): void {
    const cam = this.camera;
    const t = this.target;
    const cp = Math.cos(this.pitch);
    const x = t.x + this.distance * Math.sin(this.yaw) * cp;
    const z = t.z + this.distance * Math.cos(this.yaw) * cp;
    let y = t.y + this.distance * Math.sin(this.pitch);
    const floor = terrainHeight(x, z) + 1.5;
    if (y < floor) y = floor;
    cam.position.set(x, y, z);
    // Close in, look at the horizon-ish road ahead instead of at the tarmac.
    const lift = 1.6 * (1 - THREE.MathUtils.smoothstep(this.distance, 12, 70));
    cam.lookAt(t.x, t.y + lift, t.z);
    cam.updateMatrixWorld();
  }

  /** Ray through a client point. Leaves the camera matrices as they are. */
  ray(clientX: number, clientY: number): THREE.Ray {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.ray;
  }

  rayToPlane(clientX: number, clientY: number, y: number): THREE.Vector3 | null {
    const ray = this.ray(clientX, clientY);
    const dy = ray.direction.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = (y - ray.origin.y) / dy;
    if (t <= 0 || t > 60000) return null;
    return ray.at(t, new THREE.Vector3());
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }
}
