"use client";

import { motion, useReducedMotion } from "framer-motion";

export const Greeting = () => {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div
      className="mt-4 flex size-full flex-col justify-center md:mt-16"
      key="overview"
    >
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="font-semibold text-xl md:text-2xl"
        exit={shouldReduceMotion ? undefined : { opacity: 0, y: 10 }}
        initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
        transition={shouldReduceMotion ? { duration: 0 } : { delay: 0.5 }}
      >
        Hello there!
      </motion.div>
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="text-muted-foreground text-xl md:text-2xl"
        exit={shouldReduceMotion ? undefined : { opacity: 0, y: 10 }}
        initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
        transition={shouldReduceMotion ? { duration: 0 } : { delay: 0.6 }}
      >
        How can I help you today?
      </motion.div>
    </div>
  );
};
