"use client";

/**
 * Shared chart chrome for the telemetry column: tick styling, the Card shell
 * and the generic past/forecast LineChart frame used by both the sim traces
 * and the NASA link-budget graphs.
 */

import { Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { cn } from "../lib/cn";

export const TICK = { fill: "#6b7385", fontSize: 10 } as const;

export function Card({
  title,
  hint,
  action,
  className,
  children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("card p-3.5", className)}>
      <div className="flex items-center justify-between gap-2">
        {typeof title === "string" ? (
          <h3 className="card-title mb-0">
            {title}
          </h3>
        ) : (
          title
        )}
        {action ?? hint}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export interface SeriesSpec<T extends object> {
  past: Extract<keyof T, string>;
  fc: Extract<keyof T, string>;
  color: string;
}

export function ChartFrame<T extends object>({
  data,
  series,
  tSec,
  unit,
}: {
  data: T[];
  series: SeriesSpec<T>[];
  tSec: number;
  unit?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={112}>
      <LineChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(v: number) => new Date(v * 1000).toISOString().slice(5, 10)}
          tick={TICK}
          tickLine={false}
          axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
          minTickGap={28}
          height={16}
        />
        <YAxis
          width={40}
          tick={TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${Math.round(v)}${unit ?? ""}`}
        />
        <ReferenceLine x={tSec} stroke="rgba(255,255,255,0.42)" strokeDasharray="3 3" />
        {series.map((s) => (
          <Line
            key={String(s.past)}
            type="monotone"
            dataKey={s.past}
            stroke={s.color}
            strokeWidth={1.7}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
        {series.map((s) => (
          <Line
            key={String(s.fc)}
            type="monotone"
            dataKey={s.fc}
            stroke={s.color}
            strokeWidth={1.4}
            strokeDasharray="4 3"
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
