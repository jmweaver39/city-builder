import { describe, expect, it } from 'vitest';
import { RoadNetwork } from '../../src/core';
import { History } from '../../src/app/History';

const free = (x: number, z: number) => ({ kind: 'free' as const, pos: { x, y: 0, z } });

describe('replacing the whole map', () => {
  it('is one undo step, so a map replaced by mistake comes back', () => {
    const net = new RoadNetwork();
    const history = new History(net);
    net.drawRoad({ start: free(0, 0), end: free(200, 0), roadType: 'street-2' });
    net.setProjectName('My map');
    const mine = net.signature();
    history.replaceUndoable('Load rail demo', () => {
      net.clear('Rail demo');
      net.drawRoad({ start: free(0, 50), end: free(0, 300), roadType: 'avenue-4' });
    });
    expect(net.project.name).toBe('Rail demo');
    expect(history.undoLabel).toBe('Load rail demo');
    history.undo();
    expect(net.signature()).toBe(mine);
    expect(net.project.name).toBe('My map');
    history.redo();
    expect(net.project.name).toBe('Rail demo');
  });
});
