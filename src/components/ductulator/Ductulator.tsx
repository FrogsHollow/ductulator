"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ===================== units & physics helpers =====================
const mmToM = (mm: number) => mm / 1000;
const mToMm = (m: number) => m * 1000;
const lsToM3s = (ls: number) => ls * 0.001;
const m3hToM3s = (m3h: number) => m3h / 3600;
const safeNum = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function saturationVaporPressurePa(Tc: number) {
  // Magnus (Tetens-like) approximation
  return 610.94 * Math.exp((17.625 * Tc) / (243.04 + Tc));
}
function moistAirDensity(pressurePa: number, Tc: number, RHpercent: number) {
  const T = Tc + 273.15;
  const Rd = 287.058;
  const Rv = 461.495;
  const es = saturationVaporPressurePa(Tc);
  const pv = (RHpercent / 100) * es; // partial pressure water vapor
  const pd = Math.max(pressurePa - pv, 0); // dry air partial pressure
  return pd / (Rd * T) + pv / (Rv * T);
}
function dynamicViscosityAir(Tc: number) {
  // Sutherland’s law
  const T = Tc + 273.15;
  const mu0 = 1.716e-5; // Pa·s at 0°C
  const T0 = 273.15;
  const S = 110.4;
  return mu0 * Math.pow(T / T0, 1.5) * ((T0 + S) / (T + S));
}
function haalandFrictionFactor(Re: number, eps_over_D: number) {
  if (!Number.isFinite(Re) || Re <= 0) return NaN;
  if (Re < 2300) return 64.0 / Re; // laminar
  const A = Math.pow(eps_over_D / 3.7, 1.11) + 6.9 / Re;
  return 1.0 / Math.pow(-1.8 * Math.log10(A), 2);
}
function rectArea_m2_from_mm(w_mm: number, h_mm: number) {
  return Math.max(0, (w_mm / 1000) * (h_mm / 1000));
}
function rectPerimeter_m_from_mm(w_mm: number, h_mm: number) {
  return 2 * ((w_mm / 1000) + (h_mm / 1000));
}

const ROUGHNESS: Record<string, number> = {
  "Galvanised steel": 0.00015,
  "Mild steel": 0.000045,
  Aluminium: 0.0000018,
  PVC: 5e-7,
};

// =========================== CSV helper ===========================
function exportCSV(filename: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

// Small UI helper for results
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ============================= App ================================
type Mode = "pressureDrop" | "fixedDim" | "maxFlow" | "magic";

export default function Ductulator() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Top constants
  const [material, setMaterial] = useState<string>("Galvanised steel");
  const [presetProfile, setPresetProfile] = useState<string>("Office HVAC");
  const [temperature, setTemperature] = useState<number | string>(20);
  const [rh, setRh] = useState<number | string>(50);

  // Modes & UI
  const [mode, setMode] = useState<Mode>("pressureDrop");
  const [liveMode, setLiveMode] = useState<boolean>(false);

  // Calculation state (numbers used by solver)
  const [width, setWidth] = useState<number>(200); // mm
  const [height, setHeight] = useState<number>(200); // mm
  const [flowUnit, setFlowUnit] = useState<"L/s" | "m³/s" | "m³/h">("L/s");
  const [flowInput, setFlowInput] = useState<number>(100); // in flowUnit
  const [velocity, setVelocity] = useState<number>(0); // m/s
  const [targetDp, setTargetDp] = useState<number>(1.0); // Pa/m

  // Input buffers (what user types)
  const [bufWidth, setBufWidth] = useState<string>(String(width));
  const [bufHeight, setBufHeight] = useState<string>(String(height));
  const [bufFlowInput, setBufFlowInput] = useState<string>(String(flowInput));
  const [bufVelocity, setBufVelocity] = useState<string>(String(velocity));
  const [bufTargetDp, setBufTargetDp] = useState<string>(String(targetDp));

  // Magic mode locks
  const [magicLocks, setMagicLocks] = useState<{
    flow: boolean;
    width: boolean;
    height: boolean;
    velocity: boolean;
    dp: boolean;
  }>({ flow: false, width: false, height: false, velocity: false, dp: false });

  // Results, stale, warnings
  const [results, setResults] = useState<any>(null);
  const [stale, setStale] = useState<boolean>(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Air presets
  const AIR_PROFILES: Record<string, { T: number; RH: number }> = {
    "Office HVAC": { T: 20, RH: 50 },
    "Commercial Kitchen": { T: 30, RH: 60 },
    "Industrial Process": { T: 40, RH: 30 },
    "Cold Storage": { T: 5, RH: 70 },
  };

  // Apply preset on change
  useEffect(() => {
    const p = AIR_PROFILES[presetProfile];
    if (p) {
      setTemperature(p.T);
      setRh(p.RH);
      if (!liveMode) setStale(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetProfile]);

  // Keep buffers in sync after a solve
  useEffect(() => {
    setBufWidth(String(width));
    setBufHeight(String(height));
    setBufFlowInput(String(flowInput));
    setBufVelocity(String(velocity));
    setBufTargetDp(String(targetDp));
  }, [width, height, flowInput, velocity, targetDp]);

  // Conversions
  const flowInputToM3s = (val: number, unit: string) => {
    const v = safeNum(val, 0);
    if (unit === "L/s") return lsToM3s(v);
    if (unit === "m³/h") return m3hToM3s(v);
    return v; // m³/s
  };

  // Core rectangular duct calc
  const calcRectNums = (
    w_mm: number,
    h_mm: number,
    Q_m3s: number,
    T: number,
    RH: number,
    mat: string
  ) => {
    const p_atm = 101325;
    const rho = moistAirDensity(p_atm, T, RH);
    const mu = dynamicViscosityAir(T);
    const A = rectArea_m2_from_mm(w_mm, h_mm);
    const P = rectPerimeter_m_from_mm(w_mm, h_mm);
    const Dh = A > 0 ? (4 * A) / P : 0; // m (hydraulic diameter)
    const V = A > 0 ? Q_m3s / A : 0; // m/s
    const Re = (rho * Math.abs(V) * Dh) / mu;
    const eps = ROUGHNESS[mat] ?? 0.00015;
    const f = haalandFrictionFactor(Re, eps / Math.max(Dh, 1e-9));
    const dp_per_m = Dh > 0 ? (f * (rho * V * V)) / (2 * Dh) : Infinity; // Pa/m
    const velocityPressure = 0.5 * rho * V * V; // Pa
    const eqDiameter = Dh; // m
    return { A, Dh, V, Re, f, dp_per_m, rho, mu, velocityPressure, eqDiameter };
  };

  // Mark results stale (manual mode)
  const markStale = () => {
    if (!liveMode && results) setStale(true);
  };

  // Live mode debounce
  const liveTimer = useRef<number | null>(null);
  const scheduleLiveSolve = () => {
    if (liveTimer.current) window.clearTimeout(liveTimer.current);
    // @ts-ignore
    liveTimer.current = window.setTimeout(() => {
      applyBuffersToCalcAndSolve();
      liveTimer.current = null;
    }, 300);
  };

  // Recompute or mark stale as inputs change
  useEffect(() => {
    if (liveMode) scheduleLiveSolve();
    else markStale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bufWidth,
    bufHeight,
    bufFlowInput,
    flowUnit,
    bufVelocity,
    bufTargetDp,
    temperature,
    rh,
    material,
    mode,
    liveMode,
  ]);

  // Press Enter to solve
  const onKeyDownSolve = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyBuffersToCalcAndSolve();
    }
  };

  // -------------------- solvers --------------------
  function solveMissingDimension({
    fixedIsWidth = true,
    fixedValueDisplay,
    Q_m3s,
    targetDpPaPerM,
  }: {
    fixedIsWidth?: boolean;
    fixedValueDisplay: number;
    Q_m3s: number;
    targetDpPaPerM: number;
  }) {
    const fixed_m = mmToM(safeNum(fixedValueDisplay, 0));
    const target = safeNum(targetDpPaPerM, 0);
    if (fixed_m <= 0 || Q_m3s <= 0 || target <= 0) return null;
    let lo = 1e-4;
    let hi = 5.0;
    let best: { mid: number; dp: number } | null = null;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const w = fixedIsWidth ? fixed_m : mid;
      const h = fixedIsWidth ? mid : fixed_m;
      const calc = calcRectNums(
        mToMm(w),
        mToMm(h),
        Q_m3s,
        safeNum(temperature, 20),
        safeNum(rh, 50),
        material
      );
      const dp = calc.dp_per_m;
      if (!Number.isFinite(dp)) break;
      if (dp > target) lo = mid;
      else hi = mid;
      best = { mid, dp };
      if (Math.abs(dp - target) / Math.max(target, 1e-6) < 1e-4) break;
    }
    if (!best) return null;
    return { displayValueMm: mToMm(best.mid), dp: best.dp };
  }

  function solveMaxFlow({
    w_mm,
    h_mm,
    targetDpPaPerM,
  }: {
    w_mm: number;
    h_mm: number;
    targetDpPaPerM: number;
  }) {
    const w = mmToM(safeNum(w_mm, 0));
    const h = mmToM(safeNum(h_mm, 0));
    const target = safeNum(targetDpPaPerM, 0);
    if (w <= 0 || h <= 0 || target <= 0) return null;
    let lo = 1e-6;
    let hi = 10;
    let bestQ = 0;
    for (let i = 0; i < 80; i++) {
      const mid = 0.5 * (lo + hi);
      const calc = calcRectNums(
        mToMm(w),
        mToMm(h),
        mid,
        safeNum(temperature, 20),
        safeNum(rh, 50),
        material
      );
      const dp = calc.dp_per_m;
      if (!Number.isFinite(dp)) break;
      if (dp > target) hi = mid;
      else {
        lo = mid;
        bestQ = mid;
      }
      if (Math.abs(dp - target) / Math.max(target, 1e-6) < 1e-4) break;
    }
    return bestQ;
  }

  // ----------------- apply buffers -> solve -----------------
  function applyBuffersToCalcAndSolve() {
    setWarnings([]);
    const parsedWidth = safeNum(bufWidth, 0);
    const parsedHeight = safeNum(bufHeight, 0);
    const parsedFlowInput = safeNum(bufFlowInput, 0);
    const parsedVelocity = safeNum(bufVelocity, 0);
    const parsedTargetDp = safeNum(bufTargetDp, 0);

    setWidth(parsedWidth);
    setHeight(parsedHeight);
    setFlowInput(parsedFlowInput);
    setVelocity(parsedVelocity);
    setTargetDp(parsedTargetDp);

    runSolverWithValues({
      w_mm: parsedWidth,
      h_mm: parsedHeight,
      flowInputVal: parsedFlowInput,
      velocityVal: parsedVelocity,
      targetDpVal: parsedTargetDp,
    });
  }

  function runSolverWithValues({
    w_mm,
    h_mm,
    flowInputVal,
    velocityVal,
    targetDpVal,
  }: {
    w_mm: number;
    h_mm: number;
    flowInputVal: number;
    velocityVal: number;
    targetDpVal: number;
  }) {
    const Tn = safeNum(temperature, 20);
    const RHn = safeNum(rh, 50);
    const Q = flowInputToM3s(flowInputVal, flowUnit);

    if (mode === "pressureDrop") {
      const calc = calcRectNums(w_mm, h_mm, Q, Tn, RHn, material);
      setResults({
        mode,
        width_mm: w_mm,
        height_mm: h_mm,
        flow_m3s: Q,
        eqDiameter_m: calc.eqDiameter,
        averageVelocity: calc.V,
        effectiveVelocity: calc.V,
        dp_per_m: calc.dp_per_m,
        velocityPressure: calc.velocityPressure,
      });
      setStale(false);
      if (calc.V > 15)
        setWarnings((s) => [...s, "Velocity high (>15 m/s) — check suitability"]);
      return;
    }

    if (mode === "fixedDim") {
      const needDp = safeNum(targetDpVal, 0);
      const needV = safeNum(velocityVal, 0);
      const Qv = Q > 0 ? Q : needV > 0 ? needV * rectArea_m2_from_mm(w_mm, h_mm) : 0;
      let solvedW = w_mm;
      let solvedH = h_mm;

      if (w_mm > 0 && (!h_mm || h_mm <= 0)) {
        let hFromV: number | null = null;
        if (needV > 0 && Qv > 0) {
          const Aneed = Qv / needV;
          hFromV = mToMm(Aneed / mmToM(w_mm));
        }
        let hFromDp: number | null = null;
        if (needDp > 0 && Qv > 0) {
          const sol = solveMissingDimension({
            fixedIsWidth: true,
            fixedValueDisplay: w_mm,
            Q_m3s: Qv,
            targetDpPaPerM: needDp,
          });
          if (sol) hFromDp = sol.displayValueMm;
        }
        const candidates = [hFromV, hFromDp].filter((x) => x != null) as number[];
        const pick = candidates.length
          ? Math.max(...candidates.map((x) => safeNum(x, 0)))
          : null;
        if (pick) solvedH = pick;
      } else if (h_mm > 0 && (!w_mm || w_mm <= 0)) {
        let wFromV: number | null = null;
        if (needV > 0 && Qv > 0) {
          const Aneed = Qv / needV;
          wFromV = mToMm(Aneed / mmToM(h_mm));
        }
        let wFromDp: number | null = null;
        if (needDp > 0 && Qv > 0) {
          const sol = solveMissingDimension({
            fixedIsWidth: false,
            fixedValueDisplay: h_mm,
            Q_m3s: Qv,
            targetDpPaPerM: needDp,
          });
          if (sol) wFromDp = sol.displayValueMm;
        }
        const candidates = [wFromV, wFromDp].filter((x) => x != null) as number[];
        const pick = candidates.length
          ? Math.max(...candidates.map((x) => safeNum(x, 0)))
          : null;
        if (pick) solvedW = pick;
      }

      const calc = calcRectNums(solvedW, solvedH, Qv, Tn, RHn, material);
      setResults({
        mode,
        width_mm: solvedW,
        height_mm: solvedH,
        flow_m3s: Qv,
        dp_per_m: calc.dp_per_m,
      });
      setStale(false);
      return;
    }

    if (mode === "maxFlow") {
      const needDp = safeNum(targetDpVal, 0);
      const needV = safeNum(velocityVal, 0);
      if (needV > 0 && needDp > 0) {
        setWarnings([
          "Enter either Velocity OR Pressure Drop in Max Flow mode, not both.",
        ]);
        return;
      }
      if (needV > 0) {
        const A = rectArea_m2_from_mm(w_mm, h_mm);
        const Qcalc = needV * A;
        const calc = calcRectNums(w_mm, h_mm, Qcalc, Tn, RHn, material);
        setResults({
          mode,
          width_mm: w_mm,
          height_mm: h_mm,
          maxFlow_m3s: Qcalc,
          velocity: needV,
          dp_per_m: calc.dp_per_m,
        });
        setStale(false);
        return;
      }
      if (needDp > 0) {
        const maxQ = solveMaxFlow({ w_mm, h_mm, targetDpPaPerM: needDp });
        const calc = calcRectNums(w_mm, h_mm, maxQ || 0, Tn, RHn, material);
        setResults({
          mode,
          width_mm: w_mm,
          height_mm: h_mm,
          maxFlow_m3s: maxQ,
          velocity: calc.V,
          dp_target: needDp,
        });
        setStale(false);
        return;
      }
    }

    if (mode === "magic") {
      const locked = {
        flow: magicLocks.flow,
        width: magicLocks.width,
        height: magicLocks.height,
        velocity: magicLocks.velocity,
        dp: magicLocks.dp,
      };
      const lockedCount = Object.values(locked).filter(Boolean).length;
      if (lockedCount >= 4) {
        setWarnings(["Too many locked fields — unlock one to allow solving."]);
        return;
      }
      if (lockedCount < 2) {
        let suggestion = "";
        if (!locked.width) suggestion = "Enter duct width";
        else if (!locked.height) suggestion = "Enter duct height";
        else if (!locked.flow && !locked.velocity) suggestion = "Enter flow rate or velocity";
        else suggestion = "Provide additional locked input";
        setWarnings([`Not enough constraints — ${suggestion}.`]);
        return;
      }

      const targets = {
        flow: flowInputToM3s(flowInput, flowUnit),
        width: safeNum(w_mm, 0),
        height: safeNum(h_mm, 0),
        velocity: safeNum(velocityVal, 0),
        dp: safeNum(targetDpVal, 0),
      };

      let state = {
        flow: targets.flow || 0.1,
        width: targets.width || 200,
        height: targets.height || 200,
      };

      function residuals(s: { flow: number; width: number; height: number }) {
        const calc = calcRectNums(s.width, s.height, s.flow, Tn, RHn, material);
        const res: Record<string, number> = {};
        if (locked.flow) res.flow = (s.flow - targets.flow) / Math.max(targets.flow, 1e-6);
        if (locked.width) res.width = (s.width - targets.width) / Math.max(targets.width, 1e-6);
        if (locked.height) res.height = (s.height - targets.height) / Math.max(targets.height, 1e-6);
        if (locked.velocity) res.velocity = (calc.V - targets.velocity) / Math.max(targets.velocity, 1e-6);
        if (locked.dp) res.dp = (calc.dp_per_m - targets.dp) / Math.max(targets.dp, 1e-6);
        const keys = Object.keys(res);
        const rms = keys.length
          ? Math.sqrt(keys.map((k) => res[k] * res[k]).reduce((a, b) => a + b, 0) / keys.length)
          : 0;
        return { res, rms, calc };
      }

      let best: { state: any; rms: number; calc: any } | null = null;
      for (let iter = 0; iter < 200; iter++) {
        const stepFactors: any = { flow: 1.1, width: 1.05, height: 1.05 };
        for (const varName of ["flow", "width", "height"] as const) {
          if (
            (varName === "flow" && locked.flow) ||
            (varName === "width" && locked.width) ||
            (varName === "height" && locked.height)
          )
            continue;
          const base = { ...state } as any;
          let bestLocal = { val: base[varName], rms: Infinity };
          for (const dir of [1 / stepFactors[varName], stepFactors[varName]]) {
            const trial = { ...base } as any;
            trial[varName] = base[varName] * dir;
            trial.width = Math.max(trial.width, 10);
            trial.height = Math.max(trial.height, 10);
            trial.flow = Math.max(trial.flow, 1e-6);
            const { rms } = residuals(trial);
            if (rms < bestLocal.rms) bestLocal = { val: trial[varName], rms };
          }
          (state as any)[varName] = bestLocal.val;
        }
        const cur = residuals(state);
        if (!best || cur.rms < best.rms) best = { state: { ...state }, rms: cur.rms, calc: cur.calc };
        if (best.rms < 1e-4) break;
      }

      if (best) {
        setWidth(Number(best.state.width));
        setHeight(Number(best.state.height));
        setFlowInput(Number(best.state.flow));
        const calc = calcRectNums(best.state.width, best.state.height, best.state.flow, Tn, RHn, material);
        setResults({
          mode: "magic",
          width_mm: best.state.width,
          height_mm: best.state.height,
          flow_m3s: best.state.flow,
          velocity: calc.V,
          dp_per_m: calc.dp_per_m,
        });
        setStale(false);
        return;
      }

      setWarnings(["Magic solver failed to converge — try different locks or starting values."]);
      return;
    }
  }

  // ----------------- reset/export/screenshot -----------------
  function handleReset() {
    setWidth(200);
    setHeight(200);
    setFlowInput(100);
    setVelocity(0);
    setTargetDp(1.0);
    setResults(null);
    setStale(false);
    setWarnings([]);
    setMagicLocks({ flow: false, width: false, height: false, velocity: false, dp: false });
  }
  function handleExportCSV() {
    if (!results) return;
    const rows: (string | number)[][] = [["Key", "Value"]];
    for (const k in results) rows.push([k, String(results[k])]);
    exportCSV("ductulator-results.csv", rows);
  }
  async function handleScreenshot() {
    try {
      const html2canvas = (await import("html2canvas")).default;
      const el = containerRef.current;
      if (!el) return;
      const canvas = await html2canvas(el);
      const data = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = data;
      link.download = "ductulator-screenshot.png";
      link.click();
    } catch {
      // Fallback: print
      window.print();
    }
  }

  const toggleMagicLock = (key: keyof typeof magicLocks) => {
    setMagicLocks((s) => ({ ...s, [key]: !s[key] }));
    if (!liveMode) setStale(true);
  };
  const fmt = (v: any, d = 3) => (Number.isFinite(v) ? Number(v).toFixed(d) : "—");

  // ============================= UI =============================
  return (
    <div ref={containerRef} className="p-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Ductulator — SI</CardTitle>
              <div className="text-sm text-slate-500">
                Material & air properties (constants)
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-sm">Live mode</div>
              <Switch checked={liveMode} onCheckedChange={setLiveMode} />
              <Button variant="ghost" onClick={handleExportCSV}>
                Export CSV
              </Button>
              <Button variant="ghost" onClick={handleScreenshot}>
                Screenshot
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {/* Constants row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-2">
            <div>
              <Label>Material</Label>
              <Select
                value={material}
                onValueChange={(v) => {
                  setMaterial(v);
                  if (!liveMode) setStale(true);
                }}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select material" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(ROUGHNESS).map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Air profile</Label>
              <Select value={presetProfile} onValueChange={setPresetProfile}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(AIR_PROFILES).map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Temperature (°C)</Label>
              <Input
                className="mt-1"
                value={String(temperature)}
                onChange={(e) => {
                  setTemperature(e.target.value);
                  if (!liveMode) setStale(true);
                  else scheduleLiveSolve();
                }}
                onKeyDown={onKeyDownSolve}
              />
            </div>

            <div>
              <Label>Relative Humidity (%)</Label>
              <Input
                className="mt-1"
                value={String(rh)}
                onChange={(e) => {
                  setRh(e.target.value);
                  if (!liveMode) setStale(true);
                  else scheduleLiveSolve();
                }}
                onKeyDown={onKeyDownSolve}
              />
            </div>
          </div>

          <Separator className="my-3" />

          {/* Mode tabs */}
          <div className="mb-4">
            <Tabs
              value={mode}
              onValueChange={(v) => {
                setMode(v as Mode);
                if (!liveMode) setStale(true);
              }}
            >
              <TabsList>
                <TabsTrigger value="pressureDrop">Pressure Drop</TabsTrigger>
                <TabsTrigger value="fixedDim">Fixed Dim</TabsTrigger>
                <TabsTrigger value="maxFlow">Max Flow Rate</TabsTrigger>
                <TabsTrigger value="magic">Magic Mode</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Left: Inputs */}
            <div>
              {/* Width */}
              <div className="mb-2">
                <Label className="mb-1 block">Width (mm)</Label>
                <Input
                  value={bufWidth}
                  onChange={(e) => {
                    setBufWidth(e.target.value);
                    if (!liveMode) setStale(true);
                    else scheduleLiveSolve();
                  }}
                  onKeyDown={onKeyDownSolve}
                  disabled={mode === "magic" && magicLocks.width}
                />
              </div>

              {/* Height */}
              <div className="mb-2">
                <Label className="mb-1 block">Height (mm)</Label>
                <Input
                  value={bufHeight}
                  onChange={(e) => {
                    setBufHeight(e.target.value);
                    if (!liveMode) setStale(true);
                    else scheduleLiveSolve();
                  }}
                  onKeyDown={onKeyDownSolve}
                  disabled={mode === "magic" && magicLocks.height}
                />
              </div>

              {/* Flow + unit */}
              <div className="mb-2">
                <Label className="mb-1 block">Flow Rate</Label>
                <div className="flex gap-2">
                  <Input
                    value={bufFlowInput}
                    onChange={(e) => {
                      setBufFlowInput(e.target.value);
                      if (!liveMode) setStale(true);
                      else scheduleLiveSolve();
                    }}
                    onKeyDown={onKeyDownSolve}
                    disabled={mode === "magic" && magicLocks.flow}
                  />
                  <Select
                    value={flowUnit}
                    onValueChange={(v: "L/s" | "m³/s" | "m³/h") => {
                      setFlowUnit(v);
                      if (!liveMode) setStale(true);
                      else scheduleLiveSolve();
                    }}
                  >
                    <SelectTrigger className="w-[100px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="L/s">L/s</SelectItem>
                      <SelectItem value="m³/s">m³/s</SelectItem>
                      <SelectItem value="m³/h">m³/h</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Velocity */}
              <div className="mb-2">
                <Label className="mb-1 block">Velocity (m/s)</Label>
                <Input
                  value={bufVelocity}
                  onChange={(e) => {
                    setBufVelocity(e.target.value);
                    if (!liveMode) setStale(true);
                    else scheduleLiveSolve();
                  }}
                  onKeyDown={onKeyDownSolve}
                  disabled={mode === "magic" && magicLocks.velocity}
                />
              </div>

              {/* Target dp */}
              <div className="mb-2">
                <Label className="mb-1 block">Target pressure drop (Pa/m)</Label>
                <Input
                  value={bufTargetDp}
                  onChange={(e) => {
                    setBufTargetDp(e.target.value);
                    if (!liveMode) setStale(true);
                    else scheduleLiveSolve();
                  }}
                  onKeyDown={onKeyDownSolve}
                  disabled={mode === "magic" && magicLocks.dp}
                />
              </div>

              {/* Buttons */}
              <div className="mt-3 flex gap-2">
                <Button onClick={applyBuffersToCalcAndSolve}>Solve</Button>
                <Button variant="secondary" onClick={handleReset}>
                  Reset
                </Button>
                <Button variant="ghost" onClick={handleExportCSV}>
                  Export CSV
                </Button>
                <Button variant="ghost" onClick={handleScreenshot}>
                  Screenshot
                </Button>
              </div>

              {/* Warnings */}
              {!!warnings.length && (
                <div className="mt-3 space-y-2">
                  {warnings.map((w, i) => (
                    <div
                      key={i}
                      className="rounded border-l-4 border-amber-400 bg-amber-50 p-2 text-sm text-amber-800"
                    >
                      {w}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Right: Magic locks + Results */}
            <div>
              {mode === "magic" && (
                <div className="mb-4 rounded border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm font-medium">Magic Mode locks</div>
                    <div className="text-xs text-slate-500">
                      Lock a value to keep it fixed during solve
                    </div>
                  </div>
                  <div className="grid gap-2">
                    {[
                      { key: "flow", label: "Flow (m³/s)" },
                      { key: "width", label: "Width (mm)" },
                      { key: "height", label: "Height (mm)" },
                      { key: "velocity", label: "Velocity (m/s)" },
                      { key: "dp", label: "Pressure drop (Pa/m)" },
                    ].map((it) => (
                      <div key={it.key} className="flex items-center justify-between gap-2">
                        <div className="flex-1 text-sm">{it.label}</div>
                        <label className="inline-flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={(magicLocks as any)[it.key]}
                            onChange={() => setMagicLocks((s) => ({ ...s, [it.key]: !s[it.key] }))}
                          />
                          <span>Locked</span>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className={cn("rounded p-4", stale ? "bg-yellow-100" : "bg-white")}>
                <h4 className="mb-2 font-medium">Results</h4>
                {!results && (
                  <div className="text-sm text-slate-500">
                    No results yet — press Solve or use Live mode.
                  </div>
                )}

                {results?.mode === "pressureDrop" && (
                  <div className="space-y-1 text-sm">
                    <Row
                      label="Equivalent diameter"
                      value={`${fmt(
                        results.eqDiameter_m ? results.eqDiameter_m * 1000 : results.eqDiameter_m,
                        1
                      )} mm`}
                    />
                    <Row label="Average velocity" value={`${fmt(results.averageVelocity, 3)} m/s`} />
                    <Row
                      label="Effective velocity"
                      value={`${fmt(results.effectiveVelocity ?? results.averageVelocity, 3)} m/s`}
                    />
                    <Row label="Pressure drop" value={`${fmt(results.dp_per_m, 4)} Pa/m`} />
                    <Row label="Velocity pressure" value={`${fmt(results.velocityPressure, 3)} Pa`} />
                  </div>
                )}

                {results?.mode === "fixedDim" && (
                  <div className="space-y-1 text-sm">
                    <Row label="Width" value={`${fmt(results.width_mm, 1)} mm`} />
                    <Row label="Height" value={`${fmt(results.height_mm, 1)} mm`} />
                    <Row label="Computed pressure drop" value={`${fmt(results.dp_per_m, 4)} Pa/m`} />
                  </div>
                )}

                {results?.mode === "maxFlow" && (
                  <div className="space-y-1 text-sm">
                    <Row label="Width" value={`${fmt(results.width_mm, 1)} mm`} />
                    <Row label="Height" value={`${fmt(results.height_mm, 1)} mm`} />
                    <Row label="Max flow (m³/s)" value={`${fmt(results.maxFlow_m3s, 6)}`} />
                    <Row label="Max flow (L/s)" value={`${fmt((results.maxFlow_m3s || 0) * 1000, 3)}`} />
                  </div>
                )}

                {results?.mode === "magic" && (
                  <div className="space-y-1 text-sm">
                    <Row label="Width" value={`${fmt(results.width_mm, 1)} mm`} />
                    <Row label="Height" value={`${fmt(results.height_mm, 1)} mm`} />
                    <Row label="Flow" value={`${fmt(results.flow_m3s, 6)} m³/s`} />
                    <Row label="Velocity" value={`${fmt(results.velocity, 3)} m/s`} />
                    <Row label="Pressure drop" value={`${fmt(results.dp_per_m, 4)} Pa/m`} />
                  </div>
                )}

                {stale && (
                  <div className="mt-2 text-xs text-yellow-800">Results are stale — press Solve.</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 text-xs text-slate-600">
            Notes: Darcy–Weisbach with Haaland friction factor. Air properties derived from T & RH.
            Magic solver uses simple coordinate descent. Flow units support L/s, m³/s, m³/h.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
