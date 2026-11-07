import React from "react";
import { motion, useReducedMotion } from "framer-motion";

const REVEAL_EASE = [0.22, 1, 0.36, 1];

/**
 * A small, one-time reveal for content entering the viewport.
 * Reuses the existing Framer Motion dependency and respects reduced motion.
 */
export default function ScrollReveal({
  children,
  className = "",
  delay = 0,
  distance = 12,
  amount = 0.12,
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: distance, scale: 0.99 }}
      whileInView={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, amount, margin: "0px 0px -40px 0px" }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.56, delay, ease: REVEAL_EASE }
      }
    >
      {children}
    </motion.div>
  );
}
