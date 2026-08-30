import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { ExtractionIndicator } from './components/ExtractionProgress.js';
import { Logo } from './components/Logo.js';
import { List } from './routes/List.js';
import { RecordDetail } from './routes/RecordDetail.js';
import { Upload } from './routes/Upload.js';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors ${
    isActive ? 'bg-stone-200 text-stone-900' : 'text-stone-600 hover:bg-stone-200/60'
  }`;

export const App = () => (
  <div className="flex h-full flex-col">
    <nav className="flex shrink-0 items-center gap-1 border-b border-stone-200 bg-white px-5 py-2.5">
      <Link to="/" className="mr-5 flex items-center gap-2">
        <Logo className="h-6 w-6" />
        <span className="text-sm font-semibold tracking-tight text-stone-900">
          Invoice Extraction
        </span>
      </Link>
      <NavLink to="/" end className={navClass}>
        Upload
      </NavLink>
      <NavLink to="/records" className={navClass}>
        Records
      </NavLink>
      {/* Visible from every page, so a running extraction is never hidden by
          navigating away from the upload screen. */}
      <ExtractionIndicator />
    </nav>

    <main className="min-h-0 flex-1 overflow-y-auto">
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/records" element={<List />} />
        <Route path="/records/:id" element={<RecordDetail />} />
        <Route
          path="*"
          element={<p className="p-10 text-sm text-stone-500">Page not found.</p>}
        />
      </Routes>
    </main>
  </div>
);
