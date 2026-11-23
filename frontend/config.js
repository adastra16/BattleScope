// Where the BattleScope API lives.
//  - Deployed on Vercel: the API is a function on the same origin (/api/...), so apiBase is empty.
//  - Local dev serves the frontend on :5173 and the API on :8000.
// You can also override per visit with ?api=https://host
window.BATTLESCOPE_CONFIG = {
  apiBase: location.port === '5173' ? 'http://localhost:8000' : '',
};
