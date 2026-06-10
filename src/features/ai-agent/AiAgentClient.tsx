'use client';

import { useCallback, useState } from 'react';
import { ChatPanel } from './ChatPanel';
import { NoCreditsModal } from './NoCreditsModal';

export function AiAgentClient() {
  const [showNoCredits, setShowNoCredits] = useState(false);

  const handleNoCredits = useCallback(() => {
    setShowNoCredits(true);
  }, []);

  return (
    <div className="space-y-6">
      <ChatPanel
        api="/api/ai/sales-manager"
        placeholder="¿Cuál fue mi día más vendido este mes?"
        onNoCredits={handleNoCredits}
      />

      {showNoCredits && (
        <NoCreditsModal onClose={() => setShowNoCredits(false)} />
      )}
    </div>
  );
}
