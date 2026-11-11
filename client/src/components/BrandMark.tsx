import React from 'react';

/** Логотип панели: жёлтое кольцо (оформление Data City) */
export const BrandMark: React.FC<{ className?: string }> = ({ className = 'w-9 h-9' }) => (
  <span className={`${className} shrink-0 rounded-full bg-brand relative inline-block`} aria-hidden="true">
    <span className="absolute inset-[27%] rounded-full bg-page" />
  </span>
);
