import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { ExtractionProvider } from './api/extractionState.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Extraction takes seconds and costs API calls; nothing here benefits
      // from refetching because a window regained focus.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ExtractionProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ExtractionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
