'use client';

import { Card, Chip } from '@/components/ui';
import type { SharedEntry } from './shared';

export function SharedPlacesCard({ places }: { places?: SharedEntry[] }) {
  return (
    <Card title="共同地点" className="md:col-span-2">
      {places?.length ? (
        <div className="flex flex-wrap gap-2">
          {places.map((pl, i) => (
            <Chip key={pl.content || pl.title || String(i)} tone="plain">📍 {pl.content || pl.title}</Chip>
          ))}
        </div>
      ) : (
        <p className="dim">还没有共同去过的地方。</p>
      )}
    </Card>
  );
}