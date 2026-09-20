import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { SPRING_GLIDE } from '../../lib/ease.ts';
import { type SliderOptions, useSlider } from '../../lib/hooks/use-slider.ts';
import { TOUCH_GESTURE_CLASS } from '../../lib/touch.ts';
import { cn } from '../../lib/utils.ts';

const SPRING_BOUNCY = { type: 'spring', stiffness: 500, damping: 14, mass: 0.7 } as const;

export interface RangeSliderProps extends SliderOptions {
  label?: string;
  format?: (value: number) => string;
  showTicks?: boolean;
  className?: string;
}

export function RangeSlider({
  label,
  format = v => `${Math.round(v)}`,
  showTicks = true,
  className,
  ...options
}: RangeSliderProps) {
  const reduce = useReducedMotion();
  const { percent, current, dragging, min, max, step, trackProps, sliderProps } = useSlider({
    ...options,
    'aria-label': options['aria-label'] ?? label,
    formatValueText: options.formatValueText ?? (v => format(v)),
  });
  const [trackWidth, setTrackWidth] = useState(292);
  useLayoutEffect(() => {
    const track = trackProps.ref.current;
    if (!track) return;
    const measure = () => {
      const width = track.getBoundingClientRect().width;
      if (width > 0) setTrackWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [trackProps.ref]);

  const target = useMotionValue(percent);
  useEffect(() => { target.set(percent); }, [percent, target]);
  const smooth = useSpring(target, SPRING_GLIDE);
  const pos = reduce ? target : smooth;
  const thumbX = useTransform(pos, p => 8 + Math.max(0, trackWidth - 20) * p / 100);
  const fillX = useTransform(pos, p => p >= 100 ? '0%' : `calc(${p - 100}% + ${14 - 0.16 * p}px)`);

  const steps = Math.floor(Number(((max - min) / step).toFixed(6)));
  const ticks = showTicks && steps > 0 && steps <= 50
    ? Array.from({ length: steps + 1 }, (_, i) => Number((min + i * step).toFixed(6)))
    : [];

  return (
    <div
      {...trackProps}
      className={cn(
        'relative flex h-10 w-full touch-none items-center overflow-hidden rounded-lg bg-muted',
        TOUCH_GESTURE_CLASS,
        options.disabled ? 'pointer-events-none opacity-50' : 'cursor-grab active:cursor-grabbing',
        className,
      )}
    >
      <motion.div className="absolute inset-0 rounded-lg bg-foreground/15" style={{ x: fillX }} />
      {ticks.map(t => {
        const tp = ((t - min) / (max - min)) * 100;
        return <span key={t} className="pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/25" style={{ left: `${tp}%` }} />;
      })}
      {label || format ? (
        <div className="pointer-events-none relative z-10 flex w-full items-center justify-between gap-3 px-3 text-[11px] leading-none text-foreground/70">
          {label ? <span className="min-w-0 truncate">{label}</span> : <span />}
          <span className="shrink-0 tabular-nums text-foreground">{format(current)}</span>
        </div>
      ) : null}
      <motion.div
        {...sliderProps}
        animate={reduce ? undefined : { scaleY: dragging ? 1.35 : 1 }}
        transition={SPRING_BOUNCY}
        className="absolute top-1/2 left-0 z-20 h-6 w-1 rounded-full bg-foreground outline-none ring-inset ring-foreground/30 focus-visible:ring-4"
        style={{ x: thumbX, y: '-50%' }}
      />
    </div>
  );
}
