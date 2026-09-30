import argparse
import pathlib
from typing import List

import cv2
import numpy as np
import tqdm
from PIL import Image


def getArgs() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert CubiCasa5K PNGs to JPG for custom model")
    parser.add_argument("-id", "--input_images_dir", type=pathlib.Path, required=True, help="Folder containing cubicasa images (*.png)")
    parser.add_argument("-od", "--output_images_dir", type=pathlib.Path, required=True, help="Folder to export the cubicasa images as jpg")
    return parser.parse_args()


def load_image_without_icc(image_path: pathlib.Path) -> np.ndarray:
    # Use context manager to properly close the file pointer
    with Image.open(image_path) as img:
        img_array = np.array(img)
    
    # Handle grayscale
    if len(img_array.shape) == 2:
        img_array = cv2.cvtColor(img_array, cv2.COLOR_GRAY2BGR)
    # Handle RGB (3 channels)
    elif len(img_array.shape) == 3 and img_array.shape[2] == 3:
        img_array = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
    # Handle RGBA (4 channels) - Convert directly to BGR, dropping alpha
    elif len(img_array.shape) == 3 and img_array.shape[2] == 4:
        img_array = cv2.cvtColor(img_array, cv2.COLOR_RGBA2BGR)
        
    return img_array


def convert_export_images(input_dir: pathlib.Path, output_dir: pathlib.Path) -> None:
    # CRITICAL: Create the output directory if it doesn't exist
    output_dir.mkdir(parents=True, exist_ok=True)
    
    images: List[pathlib.Path] = sorted(list(input_dir.rglob('*.png')))
    processed_count = 0
    
    for im_path in tqdm.tqdm(images, dynamic_ncols=True):
        im_name: str = im_path.stem
        
        if 'F1' in im_name and 'original' in im_name:
            # Safely attempt to parse the parent folder name
            try:
                folder_num = int(im_path.parent.stem)
            except ValueError:
                print(f"\nSkipping {im_path}: Parent folder '{im_path.parent.stem}' is not an integer.")
                continue
                
            outname = f"{folder_num:06d}"
            outpath = output_dir / f"{outname}.jpg"
            
            im = load_image_without_icc(im_path)
            
            # Ensure it is exactly 3 channels before saving
            if len(im.shape) < 3 or im.shape[2] != 3:
                print(f"\nSkipping {im_path}: Unexpected shape {im.shape}")
                continue
                
            success = cv2.imwrite(str(outpath), im)
            
            if not success:
                print(f"\nFailed to save: {outpath}")
            else:
                processed_count += 1
                
    print(f"\nTotal PNGs scanned: {len(images)}")
    print(f"Successfully processed and saved: {processed_count}")


if __name__ == '__main__':
    args = getArgs()
    convert_export_images(args.input_images_dir, args.output_images_dir)