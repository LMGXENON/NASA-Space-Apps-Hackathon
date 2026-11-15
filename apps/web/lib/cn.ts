/**
 * className helper (clsx + tailwind-merge): compose conditional class names and
 * let later Tailwind utilities win over earlier conflicting ones.
 */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
