import os
import sys
import json
import subprocess
import tempfile

# Prepend common binary paths to PATH just in case
extra_paths = ["/usr/local/bin", "/opt/homebrew/bin"]
current_path = os.environ.get("PATH", "")
for p in extra_paths:
    if p not in current_path:
        current_path = p + os.pathsep + current_path
os.environ["PATH"] = current_path

def get_video_info(file_path):
    # Returns (width, height, has_audio)
    try:
        # Get width
        cmd_w = [
            "ffprobe", "-v", "error", "-select_streams", "v:0", 
            "-show_entries", "stream=width", "-of", "default=noprint_wrappers=1:nokey=1", 
            file_path
        ]
        width = int(subprocess.check_output(cmd_w, stderr=subprocess.STDOUT).decode().strip())
        
        # Get height
        cmd_h = [
            "ffprobe", "-v", "error", "-select_streams", "v:0", 
            "-show_entries", "stream=height", "-of", "default=noprint_wrappers=1:nokey=1", 
            file_path
        ]
        height = int(subprocess.check_output(cmd_h, stderr=subprocess.STDOUT).decode().strip())
        
        # Get audio presence
        cmd_a = [
            "ffprobe", "-v", "error", "-select_streams", "a", 
            "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", 
            file_path
        ]
        has_audio = len(subprocess.check_output(cmd_a, stderr=subprocess.STDOUT).decode().strip()) > 0
        
        return width, height, has_audio
    except subprocess.CalledProcessError as e:
        error_msg = e.output.decode().strip() if e.output else str(e)
        raise ValueError(f"Cannot inspect video {os.path.basename(file_path)}: {error_msg}")
    except Exception as e:
        raise ValueError(f"Cannot inspect video {os.path.basename(file_path)}: {str(e)}")

def merge_videos():
    project_dir = os.path.dirname(os.path.abspath(__file__))
    merge_dir = os.path.join(project_dir, "merge_file")
    
    if not os.path.exists(merge_dir):
        return {"success": False, "error": f"Folder {merge_dir} does not exist."}
        
    valid_extensions = {'.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.3gp', '.m4v'}
    
    files = []
    for item in os.listdir(merge_dir):
        item_path = os.path.join(merge_dir, item)
        if os.path.isfile(item_path):
            ext = os.path.splitext(item)[1].lower()
            if ext in valid_extensions and not item.startswith("merged_"):
                files.append(item)
                
    if not files:
        return {"success": False, "error": "No videos found in merge_file folder."}
        
    files.sort()
    
    temp_files = []
    preprocessed_videos = []
    
    try:
        # Get target resolution from the first video
        first_video_path = os.path.join(merge_dir, files[0])
        w, h, _ = get_video_info(first_video_path)
        
        # Ensure dimensions are divisible by 2
        target_w = (w // 2) * 2
        target_h = (h // 2) * 2
        
        for filename in files:
            file_path = os.path.join(merge_dir, filename)
            _, _, has_audio = get_video_info(file_path)
            
            # Create a unique temp file path for the preprocessed video
            fd, temp_video_path = tempfile.mkstemp(suffix=".mp4")
            os.close(fd)
            temp_files.append(temp_video_path)
            
            if has_audio:
                # Normal scale/pad, keeping existing audio
                cmd = [
                    "ffmpeg", "-y", "-i", file_path,
                    "-filter_complex", f"[0:v]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v]",
                    "-map", "[v]", "-map", "0:a",
                    "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p",
                    temp_video_path
                ]
            else:
                # Scale/pad, adding silent audio stream
                cmd = [
                    "ffmpeg", "-y", "-i", file_path,
                    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                    "-filter_complex", f"[0:v]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v]",
                    "-map", "[v]", "-map", "1:a",
                    "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest",
                    temp_video_path
                ]
                
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            preprocessed_videos.append(temp_video_path)
            
        # Create inputs.txt for concat demuxer
        fd_txt, txt_path = tempfile.mkstemp(suffix=".txt")
        os.close(fd_txt)
        temp_files.append(txt_path)
        
        with open(txt_path, "w") as f:
            for p in preprocessed_videos:
                f.write(f"file '{p}'\n")
                
        output_video_path = os.path.join(merge_dir, "merged_video.mp4")
        
        # Concat demuxer (very fast stream copy)
        cmd_concat = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", txt_path,
            "-c", "copy", output_video_path
        ]
        subprocess.run(cmd_concat, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        return {
            "success": True,
            "merged_file": output_video_path,
            "files_merged": files
        }
        
    except Exception as e:
        return {"success": False, "error": str(e)}
        
    finally:
        # Clean up temp files
        for temp_file in temp_files:
            try:
                if os.path.exists(temp_file):
                    os.remove(temp_file)
            except Exception:
                pass

if __name__ == "__main__":
    result = merge_videos()
    print(json.dumps(result, ensure_ascii=False))
