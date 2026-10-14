'use strict';
// Bảng xe phổ biến tại Việt Nam: [dòng xe, kiểu thân, cỡ]
// Kích thước chỉ tương đối (theo kiểu thân × cỡ), đủ để mô phỏng và trừ khoảng cách kính lái → cản trước.
const CAR_BRANDS = {
  Toyota: [['Wigo', 'hatch', 'S'], ['Vios', 'sedan', 'M'], ['Corolla Altis', 'sedan', 'M'], ['Camry', 'sedan', 'L'],
    ['Raize', 'suv', 'S'], ['Yaris Cross', 'suv', 'S'], ['Corolla Cross', 'suv', 'M'], ['Fortuner', 'suv', 'L'],
    ['Land Cruiser', 'suv', 'XL'], ['Avanza', 'mpv', 'M'], ['Veloz Cross', 'mpv', 'M'], ['Innova Cross', 'mpv', 'L'], ['Hilux', 'pickup', 'L']],
  Hyundai: [['Grand i10', 'hatch', 'S'], ['Accent', 'sedan', 'M'], ['Elantra', 'sedan', 'M'], ['Venue', 'suv', 'S'],
    ['Creta', 'suv', 'M'], ['Tucson', 'suv', 'L'], ['Santa Fe', 'suv', 'L'], ['Palisade', 'suv', 'XL'], ['Stargazer', 'mpv', 'M'], ['Custin', 'mpv', 'L']],
  Kia: [['Morning', 'hatch', 'S'], ['Soluto', 'sedan', 'S'], ['K3', 'sedan', 'M'], ['K5', 'sedan', 'L'], ['Sonet', 'suv', 'S'],
    ['Seltos', 'suv', 'M'], ['Sportage', 'suv', 'L'], ['Sorento', 'suv', 'L'], ['Carens', 'mpv', 'M'], ['Carnival', 'mpv', 'XL']],
  Mazda: [['Mazda2', 'sedan', 'S'], ['Mazda3', 'sedan', 'M'], ['Mazda6', 'sedan', 'L'], ['CX-3', 'suv', 'S'], ['CX-30', 'suv', 'M'],
    ['CX-5', 'suv', 'L'], ['CX-8', 'suv', 'XL'], ['BT-50', 'pickup', 'L']],
  Honda: [['Brio', 'hatch', 'S'], ['City', 'sedan', 'M'], ['Civic', 'sedan', 'M'], ['Accord', 'sedan', 'L'], ['HR-V', 'suv', 'M'],
    ['CR-V', 'suv', 'L'], ['BR-V', 'mpv', 'M']],
  Mitsubishi: [['Attrage', 'sedan', 'S'], ['Xforce', 'suv', 'M'], ['Outlander', 'suv', 'L'], ['Pajero Sport', 'suv', 'L'],
    ['Xpander', 'mpv', 'M'], ['Triton', 'pickup', 'L']],
  Ford: [['Territory', 'suv', 'L'], ['Everest', 'suv', 'L'], ['Ranger', 'pickup', 'L'], ['Transit', 'mpv', 'XL']],
  VinFast: [['VF 3', 'mini', 'S'], ['VF 5', 'suv', 'S'], ['VF 6', 'suv', 'M'], ['VF 7', 'suv', 'L'], ['VF 8', 'suv', 'L'],
    ['VF 9', 'suv', 'XL'], ['Limo Green', 'mpv', 'L']],
  Suzuki: [['Swift', 'hatch', 'S'], ['Ciaz', 'sedan', 'M'], ['Ertiga', 'mpv', 'M'], ['XL7', 'mpv', 'M'], ['Carry Pro', 'pickup', 'S']],
  Nissan: [['Almera', 'sedan', 'S'], ['Kicks', 'suv', 'M'], ['Navara', 'pickup', 'L']],
  Peugeot: [['2008', 'suv', 'S'], ['3008', 'suv', 'M'], ['5008', 'suv', 'L']],
  'Mercedes-Benz': [['C-Class', 'sedan', 'M'], ['E-Class', 'sedan', 'L'], ['GLC', 'suv', 'L'], ['GLE', 'suv', 'XL']],
  BMW: [['3 Series', 'sedan', 'M'], ['5 Series', 'sedan', 'L'], ['X3', 'suv', 'L'], ['X5', 'suv', 'XL']],
  BYD: [['Dolphin', 'hatch', 'S'], ['Atto 3', 'suv', 'M'], ['Seal', 'sedan', 'L']],
  'Khác': [['Sedan', 'sedan', 'M'], ['Hatchback', 'hatch', 'S'], ['SUV / CUV', 'suv', 'M'], ['MPV 7 chỗ', 'mpv', 'M'],
    ['Bán tải', 'pickup', 'L'], ['Xe mini', 'mini', 'S']],
};

// Kích thước gốc [dài, rộng, cao] (m) và khoảng cách kính lái → cản trước (m) theo kiểu thân
const BODY = {
  sedan: { dims: [4.5, 1.75, 1.45], hood: 2.0 },
  hatch: { dims: [3.9, 1.7, 1.5], hood: 1.6 },
  suv: { dims: [4.55, 1.83, 1.68], hood: 2.0 },
  mpv: { dims: [4.6, 1.8, 1.75], hood: 1.7 },
  pickup: { dims: [5.3, 1.86, 1.82], hood: 2.2 },
  mini: { dims: [3.2, 1.65, 1.62], hood: 1.1 },
};
const SIZE = { S: 0.92, M: 1, L: 1.07, XL: 1.14 };

const CAR_COLORS = [
  ['Trắng', '#f1f3f5'], ['Đen', '#1b1d21'], ['Bạc', '#b8bec6'], ['Xám', '#6b7280'], ['Đỏ', '#c81e1e'],
  ['Xanh dương', '#1d4ed8'], ['Xanh lá', '#15803d'], ['Vàng', '#eab308'], ['Nâu', '#7c4a2d'], ['Cam', '#ea580c'],
];

function carSpec(brand, model) {
  const row = (CAR_BRANDS[brand] || CAR_BRANDS['Khác']).find((r) => r[0] === model) || CAR_BRANDS['Khác'][2];
  const [, type, size] = row;
  const k = SIZE[size] || 1;
  const b = BODY[type];
  // Dài co theo cỡ, rộng/cao co ít hơn (xe lớn chủ yếu dài hơn)
  return { type, dims: [b.dims[0] * k, b.dims[1] * (1 + (k - 1) * 0.5), b.dims[2] * (1 + (k - 1) * 0.6)], hood: b.hood * (1 + (k - 1) * 0.5) };
}
