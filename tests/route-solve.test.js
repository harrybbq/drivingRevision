import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveRoute, overpassQuery, metres } from '../js/route-solve.js';
import { ROUTE } from '../js/route-data.js';

// Overpass-shaped data: ways with geometry, as `out geom` returns them.
const way = (name, points, tags = {}) => ({
  type: 'way',
  tags: { highway: 'residential', ...(name ? { name } : {}), ...tags },
  geometry: points.map(([lat, lon]) => ({ lat, lon })),
});
const osm = (...elements) => ({ elements });
const step = (road, ...names) => ({ road, direction: '', names });
const close = (a, b, m = 1) => assert.ok(metres(a, b) < m, `${a} is ${metres(a, b).toFixed(1)} m from ${b}`);
const markerFor = (r, i) => r.markers.find((m) => m.step === i);

test('a simple chain: markers where each street ends, paths between junctions', () => {
  const j1 = [55.95, -4.772];
  const j2 = [55.952, -4.772];
  const data = osm(
    way('Alpha Street', [[55.95, -4.78], [55.95, -4.776], j1]),
    way('Beta Street', [j1, [55.951, -4.772], j2]),
    way('Gamma Road', [j2, [55.952, -4.768]]),
  );
  const r = solveRoute([step('DTC'), step('A', 'Alpha Street'), step('B', 'Beta Street'), step('C', 'Gamma Road')], data);
  assert.deepEqual(r.problems, []);
  close(markerFor(r, 1).at, j1);
  close(markerFor(r, 2).at, j2);
  assert.equal(markerFor(r, 0), undefined, 'no test centre in the data');
  const beta = r.lines.find((l) => l.step === 2);
  assert.equal(beta.path.length, 3);
  assert.equal(beta.approx, false);
});

test('a test centre in the data starts and ends the route', () => {
  const dtc = [55.9505, -4.7802];
  const data = osm(
    { type: 'node', lat: dtc[0], lon: dtc[1], tags: { name: 'Greenock Driving Test Centre' } },
    way('Alpha Street', [[55.95, -4.78], [55.95, -4.776], [55.95, -4.772]]),
    way('Beta Street', [[55.95, -4.772], [55.951, -4.776], [55.9502, -4.7801]]),
  );
  const r = solveRoute([step('DTC'), step('A', 'Alpha Street'), step('B', 'Beta Street')], data);
  close(markerFor(r, 0).at, dtc);
  assert.equal(r.lines[0].step, 0);
  close(r.lines[0].path[0], dtc);
  close(r.lines.at(-1).path.at(-1), dtc);
  assert.equal(markerFor(r, 2).approx, true, 'the last turn into the centre is a guess');
});

test('a loop off a street: first meeting, then the other one coming back', () => {
  const b0 = [55.95, -4.78];
  const b1 = [55.95, -4.778];
  const b2 = [55.95, -4.776];
  const b3 = [55.95, -4.774];
  const data = osm(
    way('Xray Street', [[55.949, -4.78], b0]),
    way('Brach Street', [b0, b1, b2, b3]),
    way('Loop Road', [b1, [55.951, -4.778], [55.951, -4.776], b2]),
    way('Yankee Street', [b3, [55.949, -4.774]]),
  );
  const r = solveRoute([
    step('X', 'Xray Street'), step('B', 'Brach Street'), step('L', 'Loop Road'), step('B', 'Brach Street'), step('Y', 'Yankee Street'),
  ], data);
  assert.deepEqual(r.problems, []);
  close(markerFor(r, 1).at, b1, 1); // 1st left
  close(markerFor(r, 2).at, b2, 1); // end of the loop, back onto Brach Street
  close(markerFor(r, 3).at, b3, 1);
  const loop = r.lines.find((l) => l.step === 2);
  assert.ok(loop.path.some((p) => metres(p, [55.951, -4.778]) < 1), 'goes round the loop');
});

test('a roundabout: through it in its own direction, the long way if need be', () => {
  const r1 = [55.949, -4.77]; // south
  const r2 = [55.9495, -4.7708]; // west
  const r3 = [55.95, -4.77]; // north
  const r4 = [55.9495, -4.7692]; // east
  const data = osm(
    way('Inbound Road', [[55.948, -4.77], r1]),
    way(null, [r1, r2, r3, r4, r1], { highway: 'primary', junction: 'roundabout' }),
    way('Outbound Street', [r4, [55.9495, -4.768]]),
  );
  const r = solveRoute([step('In', 'Inbound Road'), step('Out', 'Outbound Street')], data);
  assert.deepEqual(r.problems, []);
  close(markerFor(r, 0).at, r1);
  const via = r.lines.find((l) => l.path.some((p) => metres(p, r3) < 1));
  assert.ok(via, 'goes round via the north side, not against the flow');
  assert.ok(via.path.some((p) => metres(p, r2) < 1));
});

test('streets mapped a few metres apart still meet (marked approximate)', () => {
  const data = osm(
    way('Alpha Street', [[55.95, -4.78], [55.95, -4.776]]),
    way('Beta Street', [[55.9501, -4.7759], [55.952, -4.7759]]),
  );
  const r = solveRoute([step('A', 'Alpha Street'), step('B', 'Beta Street')], data);
  assert.deepEqual(r.problems, []);
  assert.equal(markerFor(r, 0).approx, true);
});

test('a missing street is reported and the rest still places', () => {
  const data = osm(
    way('Alpha Street', [[55.95, -4.78], [55.95, -4.776]]),
    way('Beta Street', [[55.95, -4.776], [55.952, -4.776]]),
  );
  const r = solveRoute([step('A', 'Alpha Street'), step('B', 'Beta Street'), step('N', 'Nowhere Lane')], data);
  assert.ok(r.problems.some((p) => p.step === 2 && /Nowhere Lane isn't/.test(p.message)));
  close(markerFor(r, 0).at, [55.95, -4.776]);
});

test('"A / B" rows mark the junction of A and B; a crossroads straight after is allowed', () => {
  const j1 = [55.95, -4.776];
  const j2 = [55.951, -4.776];
  const j3 = [55.952, -4.776];
  const data = osm(
    way('Patrick Street', [[55.95, -4.78], j1]),
    way('Grey Place', [j1, j2]),
    way('Dalrymple Street', [j2, j3]),
    way('Rue End Street', [[55.952, -4.78], j3, [55.952, -4.772]]),
    // Dellingburn Street leaves from the same crossroads as Dalrymple meets Rue End.
    way('Dellingburn Street', [j3, [55.954, -4.776]]),
  );
  const r = solveRoute([
    step('Patrick St', 'Patrick Street'),
    step('Grey Place / Dalrymple St', 'Grey Place', 'Dalrymple Street'),
    step('Dalrymple St / Rue End St', 'Dalrymple Street', 'Rue End Street'),
    step('Dellingburn St', 'Dellingburn Street'),
  ], data);
  assert.deepEqual(r.problems, []);
  close(markerFor(r, 0).at, j1);
  close(markerFor(r, 1).at, j2);
  close(markerFor(r, 2).at, j3);
});

test('"The Esplanade" matches Esplanade', () => {
  const data = osm(
    way('Eldon Street', [[55.95, -4.78], [55.95, -4.776]]),
    way('The Esplanade', [[55.95, -4.776], [55.952, -4.776]]),
  );
  const r = solveRoute([step('Eldon St', 'Eldon Street'), step('Esplanade', 'Esplanade')], data);
  assert.deepEqual(r.problems, []);
});

test('the Overpass query asks for every street on the route inside Greenock', () => {
  const q = overpassQuery(ROUTE.steps);
  for (const name of ['Union Street', 'Drumfrochar Road', 'Old Inverkip Road', 'Esplanade', 'Campbell Street']) {
    assert.ok(q.includes(name), name);
  }
  assert.match(q, /\^\(The \)\?\(/);
  assert.match(q, /junction"~"\^\(roundabout\|circular\)\$"/);
  assert.match(q, /out geom;[\s\S]*out center;/);
});

test('the real route data is well formed', () => {
  assert.equal(ROUTE.steps.length, 23);
  assert.equal(ROUTE.steps[0].road, 'DTC');
  for (const s of ROUTE.steps.slice(1)) assert.ok(s.names.length >= 1, s.road);
  const r = solveRoute(ROUTE.steps, { elements: [] });
  assert.ok(r.problems.length > 0, 'with no data, every street is reported missing');
  assert.deepEqual(r.markers, []);
});

test('the given test centre is used when the map data has none, or only a far-off "test centre"', () => {
  const given = { name: 'Greenock Driving Test Centre', at: [55.9501, -4.7801] };
  const streets = [
    way('Alpha Street', [[55.95, -4.78], [55.95, -4.776], [55.95, -4.772]]),
    way('Beta Street', [[55.95, -4.772], [55.952, -4.772]]),
  ];
  const steps = [step('DTC'), step('A', 'Alpha Street'), step('B', 'Beta Street')];
  const none = solveRoute(steps, osm(...streets), { start: given });
  close(markerFor(none, 0).at, given.at);
  const farOff = solveRoute(steps, osm(...streets, { type: 'node', lat: 55.96, lon: -4.75, tags: { name: 'Quick MOT Test Centre' } }), { start: given });
  close(markerFor(farOff, 0).at, given.at);
  const mapped = [55.9502, -4.7799];
  const near = solveRoute(steps, osm(...streets, { type: 'node', lat: mapped[0], lon: mapped[1], tags: { name: 'Driving Test Centre' } }), { start: given });
  close(markerFor(near, 0).at, mapped);
});

test('the real route starts at the Greenock centre on Union Street', () => {
  assert.match(ROUTE.start.address, /Union Street, Greenock PA16 8DD/);
  assert.ok(metres(ROUTE.start.at, [55.9529, -4.7693]) < 1);
});
