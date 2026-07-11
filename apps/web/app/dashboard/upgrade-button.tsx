"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { useState } from "react";

export default function UpgradeButton() {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <motion.button
      className="relative transform overflow-hidden rounded-md bg-linear-to-r from-gray-900 to-black px-6 py-3 font-bold text-lg text-white shadow-lg transition-all duration-300 ease-out hover:scale-105 hover:shadow-xl"
      onHoverEnd={() => setIsHovered(false)}
      onHoverStart={() => setIsHovered(true)}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
    >
      <span className="relative z-10 flex items-center justify-center">
        <Sparkles className="mr-2 h-5 w-5" />
        Upgrade to Pro
      </span>
      <motion.div
        animate={{ opacity: isHovered ? 1 : 0 }}
        className="absolute inset-0 bg-linear-to-r from-gray-800 to-gray-700"
        initial={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
      />
      <motion.div
        animate={{ scale: isHovered ? 2 : 0, x: "0%", y: "0%" }}
        className="absolute inset-0 bg-white opacity-10"
        initial={{ scale: 0, x: "100%", y: "100%" }}
        style={{ borderRadius: "2px" }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />
    </motion.button>
  );
}
