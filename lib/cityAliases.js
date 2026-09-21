// Well-known former/colonial-era names for Indian cities that were
// officially renamed. Curated by hand rather than pulled from GeoNames'
// `alternatenames` column — see gazetteer.js for why that data is too noisy
// to index. Keyed by the current name exactly as gazetteer.lookup() returns
// it in `place` (the part before the comma).
module.exports = {
  Chennai: ['Madras'],
  Mumbai: ['Bombay'],
  Kolkata: ['Calcutta'],
  Bengaluru: ['Bangalore'],
  Kochi: ['Cochin'],
  Thiruvananthapuram: ['Trivandrum'],
  Puducherry: ['Pondicherry'],
  Vadodara: ['Baroda'],
  Mysuru: ['Mysore'],
  Kanpur: ['Cawnpore'],
  Prayagraj: ['Allahabad'],
  Gurugram: ['Gurgaon'],
};
