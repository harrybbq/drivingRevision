// The test route, as written down from the instructor's sheet. Each row is the
// road you're on and what to do at the end of it. `names` are the streets the
// row drives along, spelt as OpenStreetMap names them (a leading "The" is
// optional); a row like "Grey Place / Dalrymple St" is the junction where one
// becomes the other, and its instruction happens there.

export const ROUTE = Object.freeze({
  id: 'greenock-1',
  title: 'Greenock test route',
  // Where the route starts and ends. The position is the postcode's, so it's
  // within a street or so; OpenStreetMap's own spot for the centre wins if it's close.
  start: Object.freeze({
    name: 'Greenock Driving Test Centre',
    address: '19A Union Street, Greenock PA16 8DD',
    at: [55.9529, -4.7693],
  }),
  steps: [
    { road: 'DTC', direction: 'Right', names: [] },
    { road: 'Union St', direction: 'T/L left', names: ['Union Street'] },
    { road: 'Patrick St', direction: 'T/L right', names: ['Patrick Street'] },
    { road: 'Grey Place / Dalrymple St', direction: 'Roundabout ahead, 2nd exit', names: ['Grey Place', 'Dalrymple Street'] },
    { road: 'Dalrymple St / Rue End St', direction: 'T/L right', names: ['Dalrymple Street', 'Rue End Street'] },
    { road: 'Dellingburn St', direction: 'Roundabout ahead, 2nd exit', names: ['Dellingburn Street'] },
    { road: 'Baker St', direction: 'T/L ahead, right', names: ['Baker Street'] },
    { road: 'Drumfrochar Rd', direction: '4th right', names: ['Drumfrochar Road'] },
    { road: 'Ann St', direction: '2nd left', names: ['Ann Street'] },
    { road: 'Dempster St', direction: 'EOR left', names: ['Dempster Street'] },
    { road: 'Brachelston St', direction: '1st left', names: ['Brachelston Street'] },
    { road: 'Old Inverkip Rd', direction: 'EOR left', names: ['Old Inverkip Road'] },
    { road: 'Brachelston St', direction: 'EOR right', names: ['Brachelston Street'] },
    { road: 'Inverkip Rd', direction: 'Roundabout ahead, 2nd exit', names: ['Inverkip Road'] },
    { road: 'Nelson St', direction: '2nd left', names: ['Nelson Street'] },
    { road: 'Brisbane St', direction: '6th right', names: ['Brisbane Street'] },
    { road: 'Margaret St', direction: '2nd left', names: ['Margaret Street'] },
    { road: 'Union St / Newark St', direction: 'EOR right', names: ['Union Street', 'Newark Street'] },
    { road: 'Eldon St', direction: '3rd left', names: ['Eldon Street'] },
    { road: 'Esplanade', direction: '1st right', names: ['Esplanade'] },
    { road: 'North St', direction: 'EOR left', names: ['North Street'] },
    { road: 'Eldon St', direction: 'T/L right', names: ['Eldon Street'] },
    { road: 'Campbell St', direction: '1st left', names: ['Campbell Street'] },
  ],
});
