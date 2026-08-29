import { NavLink, Route, Routes } from 'react-router-dom';
import { List } from './routes/List.js';
import { RecordDetail } from './routes/RecordDetail.js';
import { Upload } from './routes/Upload.js';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
    isActive ? 'bg-stone-200 text-stone-900' : 'text-stone-600 hover:bg-stone-100'
  }`;

export const App = () => (
  <div className="flex h-full flex-col">
    <nav className="flex shrink-0 items-center gap-1 border-b border-stone-200 bg-white px-5 py-2">
      <span className="mr-3 text-sm font-semibold text-stone-900">Invoice Extraction</span>
      <NavLink to="/" end className={navClass}>
        Upload
      </NavLink>
      <NavLink to="/records" className={navClass}>
        Records
      </NavLink>
    </nav>

    <main className="min-h-0 flex-1 overflow-y-auto">
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/records" element={<List />} />
        <Route path="/records/:id" element={<RecordDetail />} />
        <Route
          path="*"
          element={<p className="p-10 text-sm text-stone-500">Nothing here.</p>}
        />
      </Routes>
    </main>
  </div>
);
