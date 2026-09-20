import test from 'node:test';
import assert from 'node:assert/strict';
import { snapSliderValue } from '../src/lib/hooks/use-slider.ts';

test('slider values snap to the step grid and still reach max', () => {
  assert.equal(snapSliderValue(37, 0, 100, 1), 37);
  assert.equal(snapSliderValue(99.6, 0, 100, 1), 100);
  assert.equal(snapSliderValue(8, 0, 10, 4), 8);
  assert.equal(snapSliderValue(10, 0, 10, 4), 10);
});
