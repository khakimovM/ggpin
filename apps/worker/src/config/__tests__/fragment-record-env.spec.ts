import { fragmentRecordOneDriveRoots } from '../fragment-record-env';

// The OneDrive roots the recorder refuses (R-5): each keeps the variable it came from, so a
// refusal can name the variable without its value (audit L-5, L-6).

describe('fragmentRecordOneDriveRoots', () => {
  it('returns every set root with its variable name, in a fixed order', () => {
    expect(
      fragmentRecordOneDriveRoots({
        OneDriveCommercial: 'C:/od/c',
        OneDrive: 'C:/od/a',
        OneDriveConsumer: 'C:/od/b',
      }),
    ).toEqual([
      { name: 'OneDrive', path: 'C:/od/a' },
      { name: 'OneDriveConsumer', path: 'C:/od/b' },
      { name: 'OneDriveCommercial', path: 'C:/od/c' },
    ]);
  });

  it('drops unset, empty and blank values', () => {
    expect(
      fragmentRecordOneDriveRoots({
        OneDrive: undefined,
        OneDriveConsumer: '',
        OneDriveCommercial: '  ',
      }),
    ).toEqual([]);
    expect(fragmentRecordOneDriveRoots({ OneDriveConsumer: 'C:/od/b' })).toEqual([
      { name: 'OneDriveConsumer', path: 'C:/od/b' },
    ]);
  });

  it('reads only the exact names (another letter case is not a OneDrive variable here)', () => {
    expect(fragmentRecordOneDriveRoots({ onedrive: 'C:/od/a', ONEDRIVE: 'C:/od/b' })).toEqual([]);
  });
});
